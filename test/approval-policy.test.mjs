import { ClaudeAgent } from '../src/providers/claude.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { inspectShell, wrappedShellCommand } from '../src/core/read-only-shell.ts';
import { config } from '../src/config/settings.ts';
import { processShellApproval, answerApproval, revokeShellApprovals } from '../src/server/shell-approvals.ts';
import { CodexAgent } from '../src/providers/codex.ts';

test('read-only approvals require literal arguments and keep session grants in Bridge', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'bridge-approval-test-'));
  const setting = config.autoApproveReadOnly;
  try {
    mkdirSync(path.join(root, 'subdir'));
    writeFileSync(path.join(root, 'input.txt'), 'example');
    const shell = (text) => ({ shell: 'powershell', text });
    const inspect = (text, start = root) => inspectShell(shell(text), root, start);
    assert.equal(inspect('Get-Content -LiteralPath input.txt | Select-String -Pattern example').readOnly, true);
    assert.equal(inspect('Get-ChildItem . | Select-Object FullName').readOnly, true);
    assert.equal(inspectShell(shell('Get-Content input.txt'), root).readOnly, false, 'relative paths need a known cwd');
    for (const text of [
      'Get-Content missing.txt',
      'Get-Content input.txt > output.txt',
      'Get-Content $path',
      'Get-ChildItem -Recurse -FollowSymlink',
      'git status',
      'npm test',
      'node --test',
      'py -m py_compile sample.py',
    ]) {
      assert.equal(inspect(text).readOnly, false, text);
    }
    const testCommand = 'node --test "tests/*.test.mjs" 2>&1 | Select-String ';
    assert.ok(inspect(testCommand + 'one').sessionKey);
    assert.equal(inspect(testCommand + 'one').sessionKey, inspect(testCommand + 'two').sessionKey);
    assert.notEqual(inspect(testCommand + 'one').sessionKey, inspect(testCommand + 'one', path.join(root, 'subdir')).sessionKey);
    assert.equal(inspect(testCommand + 'one; npm test').sessionKey, undefined);
    assert.equal(inspect('node --test tests/*.test.mjs').sessionKey, undefined);
    assert.equal(inspect('Get-Content input.txt | Select-String *').readOnly, false);
    assert.equal(wrappedShellCommand('powershell -Command "Get-Content input.txt"'), null);

    const owner = { workDir: root };
    const approvals = [];
    const agent = {
      id: 'a1',
      cwd: root,
      respondApproval: (id, decision) => {
        approvals.push([id, decision]);
        return true;
      },
    };
    const request = (requestId, text, cwd = root) => ({ requestId, cwd, commandApproval: true, shellCommand: shell(text) });
    config.autoApproveReadOnly = true;
    assert.equal(processShellApproval(owner, agent, request('read', 'Get-Content input.txt'), false), 'Read-only command');
    const first = request('first', testCommand + 'one');
    assert.equal(processShellApproval(owner, agent, first, false), undefined);
    assert.ok(first.decisions.includes('acceptForSession'));
    assert.equal(answerApproval(owner, agent, 'first', 'acceptForSession'), true);
    assert.deepEqual(approvals.at(-1), ['first', 'accept']);
    assert.match(processShellApproval(owner, agent, request('again', testCommand + 'two'), false), /earlier/);
    revokeShellApprovals(owner, agent.id);
    const replacement = request('replacement', testCommand + 'two');
    assert.equal(processShellApproval(owner, { ...agent }, replacement, false), undefined);
    assert.ok(replacement.decisions.includes('acceptForSession'));
    assert.equal(
      processShellApproval(owner, agent, request('different', testCommand + 'two', path.join(root, 'subdir')), false),
      undefined,
    );
    assert.equal(processShellApproval(owner, agent, request('destructive', 'Get-Content input.txt'), true), undefined);
    config.autoApproveReadOnly = false;
    assert.equal(processShellApproval(owner, agent, request('disabled', 'Get-Content input.txt'), false), undefined);
  } finally {
    if (setting === undefined) delete config.autoApproveReadOnly;
    else config.autoApproveReadOnly = setting;
    rmSync(root, { recursive: true, force: true });
  }
});

test('Codex approval keys are unique and responses preserve the provider request ID', () => {
  function request(id) {
    const agent = new CodexAgent({ id, cwd: process.cwd() });
    const events = [];
    const answers = [];
    agent.proc = { write: (message) => answers.push(message) };
    agent.on('event', (event) => events.push(event));
    agent.handleServerRequest({ method: 'item/commandExecution/requestApproval', id: 0, params: { command: 'read' } });
    return { agent, events, answers, id: events[0].requestId };
  }
  const first = request('a1');
  const second = request('a2');
  const restarted = request('a1');
  assert.equal(new Set([first.id, second.id, restarted.id]).size, 3);
  assert.equal(second.agent.respondApproval(first.id, 'accept'), false);
  assert.equal(first.agent.respondApproval(first.id, 'acceptForSession'), true);
  assert.deepEqual(first.answers, [{ id: 0, result: { decision: 'accept' } }]);
  second.agent.handleNotification('serverRequest/resolved', { requestId: 0 });
  assert.equal(second.events.find((event) => event.kind === 'approvalClosed').requestId, second.id);
});

test('Claude offers a session grant for a guarded PowerShell cd and literal output filters', () => {
  const parent = mkdtempSync(path.join(tmpdir(), 'bridge-pipe-test-'));
  const root = path.join(parent, 'project');
  const project = path.join(root, 'subdir');
  try {
    mkdirSync(project, { recursive: true });
    const agent = new ClaudeAgent({ id: 'a1', cwd: root });
    const owner = { workDir: root };
    const writes = [];
    agent.proc = { write: (message) => writes.push(message) };
    let received;
    agent.on('event', (event) => {
      if (event.kind === 'approval') received = event;
    });
    const submit = (request_id, command) => {
      agent.handleControlRequest({
        request_id,
        request: { subtype: 'can_use_tool', tool_name: 'PowerShell', input: { command, description: 'fixture' } },
      });
      return received;
    };
    const command = (filter, where = project) =>
      'cd "' + where + '"; node --test "tests/*.test.mjs" 2>&1 | Select-String -Pattern ' + filter + ' | Select -First 60';
    const first = submit('one', command("'pass|fail|^#|\\(done\\)'"));
    assert.equal(first.cwd, undefined);
    assert.equal(processShellApproval(owner, agent, first, false), undefined);
    assert.ok(first.decisions.includes('acceptForSession'));
    assert.equal(answerApproval(owner, agent, first.requestId, 'acceptForSession'), true);
    const grant = writes.at(-1).response.response;
    assert.match(grant.updatedInput.command, /^Set-Location -LiteralPath '.+' -ErrorAction Stop; node --test/);
    assert.equal(grant.updatedInput.description, 'fixture');
    assert.equal(grant.updatedPermissions, undefined);
    const second = submit('two', command("'other|[0-9]|''quote''|$literal'"));
    assert.match(processShellApproval(owner, agent, second, false), /earlier/);
    assert.match(writes.at(-1).response.response.updatedInput.command, /-ErrorAction Stop/);

    for (const [id, text] of [
      ['outside', command("'other'", parent)],
      ['double', command('"pass|fail"')],
      ['unquoted', command('[0-9]')],
      ['script-block', command("'ok'").replace('Select -First 60', 'ForEach-Object { $_ }')],
    ]) {
      const event = submit(id, text);
      assert.equal(processShellApproval(owner, agent, event, false), undefined, id);
      assert.deepEqual(event.decisions, ['accept', 'decline'], id);
    }

    const unguarded = {
      ...submit('fallback', command("'ok'")),
      requestId: 'different-provider',
    };
    const withoutGuard = { id: 'a1', cwd: root, respondApproval: () => assert.fail('requires a guarded directory change') };
    assert.equal(processShellApproval(owner, withoutGuard, unguarded, false), undefined);
    assert.deepEqual(unguarded.decisions, ['accept', 'decline']);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test('PowerShell recursion and Select -First require a safe tree and validated arguments', () => {
  const parent = mkdtempSync(path.join(tmpdir(), 'bridge-recurse-test-'));
  const root = path.join(parent, 'project');
  const outside = path.join(parent, 'outside');
  try {
    mkdirSync(path.join(root, 'nested'), { recursive: true });
    mkdirSync(outside);
    const inspect = (text) => inspectShell({ shell: 'powershell', text }, root, root);
    assert.equal(inspect('Get-ChildItem -LiteralPath nested -Recurse -File | Select -First 60').readOnly, true);
    assert.equal(inspect('Get-ChildItem -Recurse | Select-Object -First 5 FullName').readOnly, true);
    assert.equal(inspect('Get-ChildItem -Recurse | Select -First invalid').readOnly, false);
    assert.equal(inspect('Get-ChildItem -Recurse -FollowSymlink | Select -First 60').readOnly, false);
    symlinkSync(outside, path.join(root, 'nested', 'link'), process.platform === 'win32' ? 'junction' : 'dir');
    assert.equal(inspect('Get-ChildItem -LiteralPath nested -Recurse | Select -First 60').readOnly, false);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test('Get-ChildItem accepts literal depth, filename filters, and include lists', () => {
  const parent = mkdtempSync(path.join(tmpdir(), 'bridge-list-test-'));
  const root = path.join(parent, 'project');
  const outside = path.join(parent, 'outside');
  try {
    mkdirSync(path.join(root, 'nested'), { recursive: true });
    mkdirSync(outside);
    const inspect = (text, cwd) => inspectShell({ shell: 'powershell', text }, root, cwd).readOnly;
    const recordedShape =
      'Get-ChildItem "' + root + '" -Recurse -Depth 2 -Include plugin.json,marketplace.json,SKILL.md,AGENTS.md | Select-Object FullName';
    assert.equal(inspect(recordedShape), true);
    writeFileSync(path.join(root, 'plugin.json'), '{}');
    assert.equal(inspect('rg --no-config literal,pattern plugin.json', root), true);
    assert.equal(inspect('Get-ChildItem . -Depth 1 -Filter *.json', root), true);
    assert.equal(inspect("Get-ChildItem . -Depth '2' -Filter '*.json'", root), true);
    assert.equal(inspect("Get-ChildItem . -Include 'file with space.md', plugin.json, '*.yaml' -Recurse", root), true);
    for (const args of [
      '-Depth -1',
      '-Depth "2"',
      '-Depth 4294967296',
      '-Depth $count',
      '-Depth',
      '-Filter "*.json"',
      "-Filter '$name'",
      '-Filter ../*.json',
      '-Filter $(Get-Location)',
      '-Include plugin.json,',
      '-Include plugin.json,,"SKILL.md"',
      '-Include plugin.json, "SKILL.md"',
      '-Include plugin.json, $names',
      "-Include plugin.json, 'nested/*.md'",
    ]) {
      assert.equal(inspect('Get-ChildItem . ' + args, root), false, args);
    }
    assert.equal(inspect('Get-ChildItem "' + outside + '" -Depth 1 -Include plugin.json'), false);
    symlinkSync(outside, path.join(root, 'nested', 'link'), process.platform === 'win32' ? 'junction' : 'dir');
    assert.equal(inspect('Get-ChildItem . -Depth 0 -Filter plugin.json', root), true);
    assert.equal(inspect('Get-ChildItem . -Depth 1 -Filter plugin.json', root), false);
    assert.equal(inspect('Get-ChildItem . -Depth 0 -Include plugin.json', root), false);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test('Windows short-name paths are checked against the resolved workspace', { skip: process.platform !== 'win32' }, () => {
  const parent = mkdtempSync(path.join(tmpdir(), 'bridge-path-'));
  try {
    const root = path.join(parent, 'workspace');
    const inside = path.join(root, 'nested');
    mkdirSync(inside, { recursive: true });
    symlinkSync(inside, path.join(root, 'FOLDER~1'), 'junction');
    symlinkSync(parent, path.join(root, 'FOLDER~2'), 'junction');
    const inspect = (arg) => inspectShell({ shell: 'powershell', text: 'Get-Item -LiteralPath ' + arg }, root, root).readOnly;
    assert.equal(inspect('FOLDER~1'), true);
    assert.equal(inspect('FOLDER~2'), false);
    assert.equal(inspect('~'), false);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});
