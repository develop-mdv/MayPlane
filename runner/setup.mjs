import { existsSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
if (existsSync('.env.runner')) {
  console.log('.env.runner уже существует; ключи сохранены.');
  process.exit(0);
}
writeFileSync(
  '.env.runner',
  `EZDEPLOY_TOKEN=${randomBytes(32).toString('hex')}\nEZDEPLOY_ENCRYPTION_KEY=${randomBytes(32).toString('hex')}\nHOST=127.0.0.1\nPORT=8788\nALLOWED_ORIGINS=http://localhost:3000,http://127.0.0.1:3000,https://ezdeploy-control.steady-wren-0539.chatgpt.site\nEZDEPLOY_PUBLIC_URL=\n`,
  { mode: 0o600, flag: 'wx' },
);
console.log(
  'Создан .env.runner. Ключ доступа находится в EZDEPLOY_TOKEN. Не публикуйте этот файл.',
);
