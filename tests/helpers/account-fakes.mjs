import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
export function fakeProfile(options, profiles) {
  const input = new PassThrough(),
    stdout = new PassThrough(),
    stderr = new PassThrough(),
    events = new EventEmitter();
  const key = options.machineId + ':' + options.profileId;
  if (options.operation === 'profile-write') {
    let bytes = '';
    input.on('data', (chunk) => {
      bytes += chunk.toString();
      if (bytes.includes('\n')) {
        profiles.set(key, JSON.parse(bytes));
        setImmediate(() => events.emit('close', 0));
      }
    });
  } else
    setImmediate(() => {
      if (options.operation === 'profile-read')
        stdout.write(
          JSON.stringify(
            profiles.get(key) ||
              (options.profileFormat === 'opencode-v2' ? [] : {}),
          ),
        );
      else profiles.delete(key);
      events.emit('close', 0);
    });
  return { input, stdout, stderr, events, close() {} };
}
export function fakeAccountBrokers() {
  const logins = [];
  let refreshes = 0;
  const jwt = (id, expires = Date.now() / 1000 + 3600) =>
    'header.' +
    Buffer.from(
      JSON.stringify({
        exp: expires,
        'https://api.openai.com/auth': {
          chatgpt_account_id: id,
          chatgpt_plan_type: 'plus',
        },
      }),
    ).toString('base64url') +
    '.signature';
  const oauth = (id) => ({
    tokens: {
      access_token: jwt(id),
      id_token: jwt(id),
      refresh_token: 'private-refresh-' + id,
      account_id: id,
    },
  });
  return {
    logins,
    get refreshes() {
      return refreshes;
    },
    oauth,
    codexLogin: async (id, initial, onLogin) => {
      let credentials = initial || oauth('org-personal');
      const login = { id, onLogin, closed: false };
      logins.push(login);
      return {
        read: async (force) => {
          if (force) refreshes++;
          return {
            credentials,
            account: {
              type: credentials.OPENAI_API_KEY ? 'apiKey' : 'chatgpt',
              email: credentials.OPENAI_API_KEY?.includes('work')
                ? 'work@example.test'
                : 'personal@example.test',
              planType: 'plus',
            },
          };
        },
        login: async (key) => {
          if (key) {
            credentials = { OPENAI_API_KEY: key };
            return null;
          }
          return {
            url: 'https://auth.openai.com/codex/device',
            userCode: 'SAFE-CODE',
            mode: 'device',
          };
        },
        close: async () => {
          login.closed = true;
        },
      };
    },
    openCodeLogin: async (id) => {
      let vendor = 'openai',
        key = 'private-opencode-key',
        authType = 'api',
        complete = false;
      const login = {
        id,
        closed: false,
        complete: () => {
          complete = true;
        },
      };
      logins.push(login);
      const credentials = () => ({
        legacy: {
          [vendor]:
            authType === 'api'
              ? { type: 'api', key }
              : {
                  type: 'oauth',
                  access: 'private-access',
                  refresh: 'private-refresh',
                  expires: Date.now() + 3600000,
                },
        },
        native2: [
          {
            id: 'cred_test' + id.replaceAll('-', ''),
            integrationID: vendor,
            label: 'Connected',
            active: true,
            value:
              authType === 'api'
                ? { type: 'key', key }
                : {
                    type: 'oauth',
                    methodID: 'chatgpt-headless',
                    access: 'private-access',
                    refresh: 'private-refresh',
                    expires: Date.now() + 3600000,
                  },
          },
        ],
      });
      return {
        version: 2,
        providers: async () => [
          {
            id: 'openai',
            name: 'OpenAI',
            methods: [
              { id: 'key', type: 'api', name: 'API key', fields: [] },
              { id: 'device', type: 'oauth', name: 'Device code', fields: [] },
            ],
          },
        ],
        login: async (v, method, _inputs, _label, apiKey) => {
          vendor = v;
          if (apiKey) {
            key = apiKey;
            return null;
          }
          authType = 'oauth';
          return {
            url: 'https://auth.openai.com/codex/device',
            instructions: 'Enter SAFE-CODE',
            mode: 'auto',
            vendor,
            attemptId: 'attempt',
          };
        },
        poll: async () => ({ status: complete ? 'complete' : 'pending' }),
        credentials: async () => credentials(),
        close: async () => {
          login.closed = true;
        },
      };
    },
  };
}
