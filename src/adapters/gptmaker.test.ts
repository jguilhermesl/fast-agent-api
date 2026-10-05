import axios from 'axios';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getAdapter, gptmakerSend } from './messaging';

const CREDS = { channel_id: '3F9E52BB9FF2E07BB6CBB2A168BE1359' };
const URL = 'https://api.gptmaker.ai/v2/chat/3F9E52BB9FF2E07BB6CBB2A168BE1359-558199990000/send-message';

beforeEach(() => vi.stubEnv('GPTMAKER_TOKEN', 'tok-teste'));
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('gptmakerSend', () => {
  it('texto: chatId = canal-telefone, só dígitos, Bearer do canal', async () => {
    const post = vi.spyOn(axios, 'post').mockResolvedValue({ data: { success: true } });
    const r = await gptmakerSend(CREDS, { phone: '+55 (81) 9999-0000', content: 'Boa tarde, Ana!' });
    expect(r).toEqual({ success: true });
    expect(post).toHaveBeenCalledWith(URL, { message: 'Boa tarde, Ana!' }, expect.objectContaining({
      headers: expect.objectContaining({ Authorization: 'Bearer tok-teste' }),
    }));
  });

  it('foto da ficha: image + legenda', async () => {
    const post = vi.spyOn(axios, 'post').mockResolvedValue({ data: { success: true } });
    const foto = 'https://costaemuniz-crm.lovable.app/imoveis/cobertura-cabo-branco.jpg';
    await gptmakerSend(CREDS, { phone: '558199990000', content: 'Piscina', type: 'image', mediaUrl: foto });
    expect(post.mock.calls[0][1]).toEqual({ image: foto, message: 'Piscina' });
  });

  it('áudio e documento no formato da API', async () => {
    const post = vi.spyOn(axios, 'post').mockResolvedValue({ data: { success: true } });
    await gptmakerSend(CREDS, { phone: '558199990000', content: '', type: 'ptt', mediaUrl: 'https://x/a.ogg' });
    await gptmakerSend(CREDS, { phone: '558199990000', content: '', type: 'document', mediaUrl: 'https://x/Tabela%20de%20pre%C3%A7os.pdf?v=1' });
    expect(post.mock.calls[0][1]).toEqual({ audio: 'https://x/a.ogg' });
    expect(post.mock.calls[1][1]).toEqual({ document: 'https://x/Tabela%20de%20pre%C3%A7os.pdf?v=1', documentName: 'Tabela de preços.pdf' });
  });

  it('sem channel_id: falha sem chamar a API', async () => {
    const post = vi.spyOn(axios, 'post');
    const r = await gptmakerSend({}, { phone: '558199990000', content: 'oi' });
    expect(r.success).toBe(false);
    expect(post).not.toHaveBeenCalled();
  });

  it('token nunca vem do canal (o banco é legível pelo tenant): sem GPTMAKER_TOKEN, falha', async () => {
    vi.stubEnv('GPTMAKER_TOKEN', '');
    const post = vi.spyOn(axios, 'post');
    const r = await gptmakerSend({ ...CREDS, api_token: 'token-no-banco' }, { phone: '558199990000', content: 'oi' });
    expect(r).toEqual({ success: false, error: 'GPT Maker: variável GPTMAKER_TOKEN ausente no servidor' });
    expect(post).not.toHaveBeenCalled();
  });

  it('texto vazio: falha em vez de mandar bolha vazia', async () => {
    const post = vi.spyOn(axios, 'post');
    const r = await gptmakerSend(CREDS, { phone: '558199990000', content: '' });
    expect(r.success).toBe(false);
    expect(post).not.toHaveBeenCalled();
  });

  it('{success:false} do GPT Maker vira falha', async () => {
    vi.spyOn(axios, 'post').mockResolvedValue({ data: { success: false, message: 'chat não encontrado' } });
    const r = await gptmakerSend(CREDS, { phone: '558199990000', content: 'oi' });
    expect(r.success).toBe(false);
  });

  it('erro HTTP vira falha com o status, sem vazar o token', async () => {
    const err = Object.assign(new Error('Request failed'), {
      isAxiosError: true,
      response: { status: 401, data: { message: 'token inválido' } },
    });
    vi.spyOn(axios, 'post').mockRejectedValue(err);
    vi.spyOn(axios, 'isAxiosError').mockReturnValue(true);
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const r = await gptmakerSend(CREDS, { phone: '558199990000', content: 'oi' });
    expect(r).toEqual({ success: false, error: 'GPT Maker HTTP 401: token inválido' });
    expect(JSON.stringify(log.mock.calls)).not.toContain('tok-teste');
  });

  it('getAdapter conhece o provedor gptmaker', () => {
    expect(() => getAdapter('gptmaker')).not.toThrow();
    expect(() => getAdapter('inexistente')).toThrow();
  });
});
