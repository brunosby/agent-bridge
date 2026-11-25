import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ClaudeAgent } from '../src/providers/claude.ts';
import { startAndWait, statusOf } from '../src/server/agent-lifecycle.ts';

function fixture(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'bridge claude startup '));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const script = path.join(dir, 'models.cjs');
  writeFileSync(
    script,
    [
      "require('node:readline').createInterface({input:process.stdin}).once('line',line=>{",
      "if(JSON.parse(line).request.subtype!=='initialize')process.exit(1);",
      "require('node:fs').writeFileSync('args.json',JSON.stringify(process.argv.slice(2)));",
      "console.log(JSON.stringify({type:'control_response',response:{response:{models:[{value:'fixture'}]}}}));",
      '});',
    ].join('\n'),
  );
  return { dir, script };
}
test('Claude reports missing or unstartable commands immediately', async (t) => {
  const { dir } = fixture(t);
  for (const [command, cwd] of [
    ['bridge-missing-provider-for-test', dir],
    [process.execPath, path.join(dir, 'missing-directory')],
  ]) {
    const agent = new ClaudeAgent({ cwd, config: { command } });
    const ready = await startAndWait(
      agent,
      () => agent.start(),
      () => {},
      1000,
    );
    assert.equal(ready, false);
    assert.equal(agent.available, false);
    assert.equal(agent.proc, null);
    assert.match(agent.unavailableReason, /ENOENT.*claude\.command/i);
    assert.equal(statusOf(agent).reason, agent.unavailableReason);
  }
});

test('configured native executable receives literal arguments and completes the Claude handshake', async (t) => {
  const { dir, script } = fixture(t);
  const agent = new ClaudeAgent({ cwd: dir, config: { command: process.execPath } });
  const expected = agent.buildArgs();
  agent.buildArgs = () => [script, ...expected];
  try {
    assert.ok(
      await startAndWait(
        agent,
        () => agent.start(),
        () => {},
        4000,
      ),
      agent.unavailableReason,
    );
    assert.deepEqual(JSON.parse(readFileSync(path.join(dir, 'args.json'), 'utf8')), expected);
    assert.equal(agent.models[0].value, 'fixture');
  } finally {
    await agent.shutdown();
  }
});

test(
  'Windows finds the npm launcher on PATH and preserves settings JSON and file names',
  { skip: process.platform !== 'win32' },
  async (t) => {
    const { dir, script } = fixture(t);
    const shim = 'bridge-claude-fixture';
    writeFileSync(
      path.join(dir, shim + '.cmd'),
      '@echo off\r\nSETLOCAL\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "' +
        process.execPath +
        '" "' +
        script +
        '" %*\r\n',
    );
    writeFileSync(path.join(dir, shim + '.bat'), '@echo off\r\n"' + process.execPath + '" "' + script + '" %*\r\n');
    const original = process.env.PATH;
    process.env.PATH = dir + path.delimiter + original;
    const extensions = process.env.PATHEXT;
    process.env.PATHEXT = '.CMD;.BAT;.EXE;.COM';
    const agent = new ClaudeAgent({
      cwd: dir,
      config: { command: shim, extraArgs: ['two words', 'A & B', 'quote " inside', 'C:\\space here\\', '%TEMP%', 'hello!', ''] },
      systemPromptFile: path.join(dir, 'support role.md'),
    });
    try {
      assert.ok(
        await startAndWait(
          agent,
          () => agent.start(),
          () => {},
          4000,
        ),
        agent.unavailableReason,
      );
      assert.deepEqual(JSON.parse(readFileSync(path.join(dir, 'args.json'), 'utf8')), agent.buildArgs());
      agent.config.command = path.join(dir, shim + '.bat');
      assert.ok(
        await startAndWait(
          agent,
          () => agent.restart(),
          () => {},
          4000,
        ),
        agent.unavailableReason,
      );
      assert.deepEqual(JSON.parse(readFileSync(path.join(dir, 'args.json'), 'utf8')), agent.buildArgs());
    } finally {
      process.env.PATH = original;
      if (extensions === undefined) delete process.env.PATHEXT;
      else process.env.PATHEXT = extensions;
      await agent.shutdown();
    }
  },
);
