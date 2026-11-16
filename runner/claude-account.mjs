import { assert } from './security.mjs';

export const claudeAuthProviders = [
  {
    id: 'anthropic',
    name: 'Anthropic',
    methods: [
      {
        id: 'subscription',
        type: 'native',
        name: 'Войти с подпиской Claude',
        fields: [],
      },
      { id: 'api', type: 'api', name: 'Anthropic API-ключ', fields: [] },
    ],
  },
];
export async function claudeBroker() {
  let credentials;
  return {
    async login(key) {
      assert(
        typeof key === 'string' && key.trim() && key.length <= 32768,
        'Введите Anthropic API-ключ',
      );
      credentials = { apiKey: key.trim() };
      return null;
    },
    async read() {
      assert(credentials, 'Добавьте API-ключ');
      return { credentials };
    },
    async close() {
      credentials = undefined;
    },
  };
}
