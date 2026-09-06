// Offline administrative entry, deliberately separate from plugin HTTP routes.
import { inspectImageServiceRecovery, recoverImageServiceRecords, restoreInterruptedImageRecovery } from '../qianmu-image-service-recovery.js';

const args = process.argv.slice(2), values = {};
try {
  for (let index = 0; index < args.length; index++) {
    const key = args[index];
    if (!['--data-root', '--confirm', '--server-stopped', '--inspect', '--restore-backup'].includes(key) || Object.hasOwn(values, key)) throw Error('invalid arguments');
    if (['--server-stopped', '--inspect'].includes(key)) values[key] = true;
    else { const value = args[++index]; if (!value || value.startsWith('--')) throw Error('missing value'); values[key] = value; }
  }
  if (!values['--data-root'] || ['--inspect', '--confirm', '--restore-backup'].filter(key => values[key]).length !== 1) throw Error('mode required');
  const result = values['--inspect']
    ? await inspectImageServiceRecovery({ dataRoot: values['--data-root'] })
    : values['--restore-backup']
      ? await restoreInterruptedImageRecovery({ dataRoot: values['--data-root'], backupId: values['--restore-backup'], serverStopped: values['--server-stopped'] === true })
      : await recoverImageServiceRecords({ dataRoot: values['--data-root'], confirmation: values['--confirm'], serverStopped: values['--server-stopped'] === true });
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (cause) {
  process.stderr.write(`${JSON.stringify({ ok: false, code: String(cause?.code || 'image_service_recovery_arguments'), message: cause?.code ? cause.message : '请提供 --data-root 和 --inspect；离线恢复另需核查所得 --confirm 与 --server-stopped。',
    ...(/^[a-f0-9-]{36}$/.test(cause?.backupId || '') ? { backupId: cause.backupId, recoveryInterrupted: cause.recoveryInterrupted === true } : {}),
  })}\n`);
  process.exitCode = 1;
}
