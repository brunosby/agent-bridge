// Replace only the OS browser launch. The server and second launcher communicate over real HTTP.
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { FakeAgent } from '../../src/providers/fake.ts';
const exec = childProcess.execFile;
childProcess.execFile = function (file, args, ...rest) {
  const link = Array.isArray(args) && args.at(-1);
  if (['cmd', 'open', 'xdg-open'].includes(file) && typeof link === 'string' && /^http:\/\/127\.0\.0\.1:\d+\/#abrir=/.test(link)) {
    process.send({ opening: link });
    return;
  }
  return exec.call(this, file, args, ...rest);
};
syncBuiltinESMExports();
const original = FakeAgent.prototype.send;
FakeAgent.prototype.send = function (text, id) {
  if (text.includes('fixture-shell-review')) {
    const command = 'curl http://127.0.0.1:' + process.argv[process.argv.indexOf('--port') + 1] + '/';
    const requestId = 'fixture-bridge-access';
    this.approvals.set(requestId, true);
    this.emitEvent('approval', {
      requestId,
      title: 'Shell command',
      detail: command,
      matchText: command,
      commandApproval: true,
      shellCommand: { shell: 'bash', text: command },
      decisions: ['accept', 'decline'],
    });
  }
  if (text.includes('fixture-secret-diagnostics')) {
    const message = 'Fixture error ' + 'ghp_' + '0123456789abcdefghijklmnopqrstuvwxyz';
    this.emitEvent('stderr', { text: message });
    this.emitEvent('error', { text: message });
    this.emitEvent('tool', { key: 'fixture-tool', title: 'Shell', detail: message });
    console.error(message);
  }
  original.call(this, text, id);
};
FakeAgent.prototype.respondApproval = function (id) {
  return this.approvals.delete(id);
};
