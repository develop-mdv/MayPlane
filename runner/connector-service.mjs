import { mkdirSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
const xml = (value) =>
  String(value).replace(
    /[<>&"']/g,
    (c) =>
      ({
        '<': '&lt;',
        '>': '&gt;',
        '&': '&amp;',
        '"': '&quot;',
        "'": '&apos;',
      })[c],
  );
const winQuote = (value) =>
  '"' +
  String(value)
    .replace(/(\\*)"/g, '$1$1\\"')
    .replace(/(\\+)$/, '$1$1') +
  '"';
const unitQuote = (value) =>
  '"' +
  String(value)
    .replaceAll('\\', '\\\\')
    .replaceAll('"', '\\"')
    .replaceAll('%', '%%') +
  '"';
export function connectorServicePlan(
  platform,
  {
    home = os.homedir(),
    directory,
    node = process.execPath,
    script = fileURLToPath(new URL('./connector.mjs', import.meta.url)),
    username = os.userInfo().username,
    domain = process.env.USERDOMAIN,
    uid = process.getuid?.(),
  } = {},
) {
  if (!directory) throw new Error('Нужен каталог коннектора');
  const args = [script, '--data-dir', directory];
  for (const value of [node, ...args, home])
    if (['\r', '\n', '\0'].some((c) => value.includes(c)))
      throw new Error('Недопустимый путь службы');
  if (platform === 'linux')
    return {
      path: join(
        home,
        '.config',
        'systemd',
        'user',
        'mayplane-connector.service',
      ),
      content: `[Unit]\nDescription=MayPlane personal computer connector\nAfter=network-online.target\n\n[Service]\nType=simple\nExecStart=${[node, ...args].map(unitQuote).join(' ')}\nRestart=on-failure\nRestartSec=5\n\n[Install]\nWantedBy=default.target\n`,
      install: [
        ['systemctl', ['--user', 'daemon-reload']],
        [
          'systemctl',
          ['--user', 'enable', '--now', 'mayplane-connector.service'],
        ],
      ],
      stop: [
        [
          'systemctl',
          ['--user', 'disable', '--now', 'mayplane-connector.service'],
        ],
      ],
      afterRemove: [['systemctl', ['--user', 'daemon-reload']]],
    };
  if (platform === 'darwin') {
    const path = join(
        home,
        'Library',
        'LaunchAgents',
        'app.mayplane.connector.plist',
      ),
      target = `gui/${uid}`;
    return {
      path,
      content: `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>app.mayplane.connector</string><key>ProgramArguments</key><array>${[node, ...args].map((a) => `<string>${xml(a)}</string>`).join('')}</array><key>EnvironmentVariables</key><dict><key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string></dict><key>RunAtLoad</key><true/><key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict><key>ThrottleInterval</key><integer>10</integer><key>StandardOutPath</key><string>${xml(join(directory, 'connector.log'))}</string><key>StandardErrorPath</key><string>${xml(join(directory, 'connector.log'))}</string></dict></plist>`,
      beforeInstall: [
        ['launchctl', ['bootout', `${target}/app.mayplane.connector`]],
      ],
      install: [['launchctl', ['bootstrap', target, path]]],
      stop: [['launchctl', ['bootout', `${target}/app.mayplane.connector`]]],
      afterRemove: [],
    };
  }
  if (platform === 'win32') {
    const path = join(directory, 'autostart.xml'),
      user = domain ? `${domain}\\${username}` : username;
    const psQuote = (value) => "'" + String(value).replaceAll("'", "''") + "'";
    const bootstrap = `try { $deviceConnectorProcess = Start-Process -FilePath ${psQuote(node)} -ArgumentList ${psQuote(args.map(winQuote).join(' '))} -WindowStyle Hidden -Wait -PassThru; exit $deviceConnectorProcess.ExitCode } catch { exit 1 }`;
    const command = join(
      process.env.SystemRoot || 'C:\\Windows',
      'System32/WindowsPowerShell/v1.0/powershell.exe',
    );
    const argumentsText =
      '-NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand ' +
      Buffer.from(bootstrap, 'utf16le').toString('base64');
    return {
      path,
      content: `<?xml version="1.0" encoding="UTF-16"?><Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task"><Triggers><LogonTrigger><Enabled>true</Enabled><UserId>${xml(user)}</UserId></LogonTrigger></Triggers><Principals><Principal id="Author"><UserId>${xml(user)}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals><Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><StartWhenAvailable>true</StartWhenAvailable><ExecutionTimeLimit>PT0S</ExecutionTimeLimit><RestartOnFailure><Interval>PT1M</Interval><Count>999</Count></RestartOnFailure></Settings><Actions Context="Author"><Exec><Command>${xml(command)}</Command><Arguments>${xml(argumentsText)}</Arguments></Exec></Actions></Task>`,
      encoding: 'utf16le',
      install: [
        [
          'schtasks.exe',
          ['/Create', '/TN', 'mayplane-connector', '/XML', path, '/F'],
        ],
        ['schtasks.exe', ['/Run', '/TN', 'mayplane-connector']],
      ],
      stop: [
        ['schtasks.exe', ['/End', '/TN', 'mayplane-connector']],
        ['schtasks.exe', ['/Delete', '/TN', 'mayplane-connector', '/F']],
      ],
      afterRemove: [],
    };
  }
  throw new Error('Автозапуск поддерживается на Windows, macOS и Linux');
}
export function configureConnectorService(action, directory) {
  directory = resolve(directory);
  const marker = join(directory, 'autostart-managed.json');
  const plan = connectorServicePlan(process.platform, { directory });
  const execute = ([cmd, args]) =>
    execFileSync(cmd, args, {
      windowsHide: true,
      stdio: 'pipe',
      timeout: 15000,
    });
  if (action === 'install') {
    if (!existsSync(join(directory, 'connection.json')))
      throw new Error('Сначала подключите компьютер одноразовым кодом');
    mkdirSync(dirname(plan.path), { recursive: true, mode: 0o700 });
    for (const command of plan.beforeInstall || [])
      try {
        execute(command);
      } catch {}
    writeFileSync(
      plan.path,
      (plan.encoding === 'utf16le' ? '\ufeff' : '') + plan.content,
      {
        mode: 0o600,
        encoding: plan.encoding || 'utf8',
      },
    );
    writeFileSync(marker, JSON.stringify({ path: plan.path }), { mode: 0o600 });
    try {
      for (const command of plan.install) execute(command);
    } catch {
      throw new Error(
        'Не удалось включить автозапуск в пользовательском сеансе. Проверьте доступ к Планировщику заданий, launchd или systemd --user. Файл службы сохранён для повторной установки.',
      );
    }
    console.log(
      'Автозапуск включён для текущего пользователя. Коннектор запускается при входе в систему.',
    );
  } else {
    if (!existsSync(marker))
      throw new Error('Автозапуск из этого профиля не установлен');
    for (const command of plan.stop)
      try {
        execute(command);
      } catch {}
    if (existsSync(plan.path)) unlinkSync(plan.path);
    for (const command of plan.afterRemove || []) execute(command);
    unlinkSync(marker);
    console.log('Автозапуск отключён. Ключ подключения сохранён.');
  }
}
