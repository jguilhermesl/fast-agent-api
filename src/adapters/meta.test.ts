import axios from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getAdapter } from './messaging';
import { corpoMeta, metaSend, motivoMeta } from './meta';

const CREDS = { phone_number_id: '106540352242922', waba_id: '102290129340398' };
const URL_ENVIO = 'https://graph.facebook.com/v23.0/106540352242922/messages';
const token = vi.fn(async () => 'tok-cliente');

afterEach(() => {
  vi.restoreAllMocks();
  token.mockClear();
});

describe('metaSend', () => {
  it('texto: POST no phone_number_id, só dígitos no to, devolve o wamid', async () => {
    const post = vi.spyOn(axios, 'post').mockResolvedValue({ data: { messages: [{ id: 'wamid.HBgM' }] } });
    const r = await metaSend(CREDS, { phone: '+55 (81) 9999-0000', content: 'Boa tarde, Ana!' }, token);
    expect(r).toEqual({ success: true, providerMessageId: 'wamid.HBgM' });
    expect(token).toHaveBeenCalledWith('106540352242922');
    expect(post).toHaveBeenCalledWith(
      URL_ENVIO,
      {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: '558199990000',
        type: 'text',
        text: { body: 'Boa tarde, Ana!', preview_url: true },
      },
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer tok-cliente' }) }),
    );
  });

  it('foto com legenda, áudio e documento com nome', () => {
    expect(corpoMeta('5581', { phone: '', content: 'Piscina', type: 'image', mediaUrl: 'https://x/f.jpg' }))
      .toMatchObject({ type: 'image', image: { link: 'https://x/f.jpg', caption: 'Piscina' } });
    expect(corpoMeta('5581', { phone: '', content: '', type: 'ptt', mediaUrl: 'https://x/a.ogg' }))
      .toMatchObject({ type: 'audio', audio: { link: 'https://x/a.ogg' } });
    expect(corpoMeta('5581', { phone: '', content: '', type: 'document', mediaUrl: 'https://x/Tabela%20de%20pre%C3%A7os.pdf?v=1' }))
      .toMatchObject({ type: 'document', document: { link: 'https://x/Tabela%20de%20pre%C3%A7os.pdf?v=1', filename: 'Tabela de preços.pdf' } });
  });

  it('sem phone_number_id, sem telefone ou texto vazio: falha sem chamar a API', async () => {
    const post = vi.spyOn(axios, 'post');
    expect((await metaSend({}, { phone: '5581', content: 'oi' }, token)).success).toBe(false);
    expect((await metaSend(CREDS, { phone: '', content: 'oi' }, token)).success).toBe(false);
    expect((await metaSend(CREDS, { phone: '5581', content: '' }, token)).success).toBe(false);
    expect(post).not.toHaveBeenCalled();
  });

  it('sem token no banco: falha sem chamar a API', async () => {
    const post = vi.spyOn(axios, 'post');
    const r = await metaSend(CREDS, { phone: '5581', content: 'oi' }, async () => null);
    expect(r).toEqual({ success: false, error: 'Meta: canal sem token em channel_secrets' });
    expect(post).not.toHaveBeenCalled();
  });

  it('fora da janela de 24h vira motivo legível, sem vazar o token', async () => {
    const err = Object.assign(new Error('Request failed'), {
      isAxiosError: true,
      response: { status: 400, data: { error: { code: 131047, message: 'Re-engagement message' } } },
    });
    vi.spyOn(axios, 'post').mockRejectedValue(err);
    vi.spyOn(axios, 'isAxiosError').mockReturnValue(true);
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const r = await metaSend(CREDS, { phone: '5581', content: 'oi' }, token);
    expect(r).toEqual({ success: false, error: 'Meta: passou da janela de 24h, só modelo aprovado pode ser enviado' });
    expect(JSON.stringify(log.mock.calls)).not.toContain('tok-cliente');
  });

  it('código desconhecido mantém a mensagem da Meta', () => {
    expect(motivoMeta(368, 'Temporarily blocked')).toBe('Meta 368: Temporarily blocked');
  });

  it('getAdapter conhece o provedor meta', () => {
    expect(() => getAdapter('meta')).not.toThrow();
  });
});
