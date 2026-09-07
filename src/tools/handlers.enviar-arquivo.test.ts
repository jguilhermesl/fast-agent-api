import { describe, it, expect, vi, beforeEach } from 'vitest';
import axios from 'axios';

// `enviar_arquivo` apontava para a Supabase Function `send-media`, congelada
// desde 03/03/2026 (código da era Chatwoot, deletado do repo, nunca
// redeployado). Ela consulta `agents.chatwoot_inbox_id`, coluna que não existe
// mais, e fala com uma API que não existe mais nesta plataforma — por isso
// falha sempre (medido: Duda e Diana, 30+ tentativas em 2 meses, sempre erro).
//
// O envio real de mídia já existe e funciona: `/api/send-external`, a mesma
// rota que o `messaging-gateway` (chat-flow-pilot-63) chama para o canal
// WhatsBizAPI. Roda no mesmo processo do Executor, então o fix é apontar
// `enviar_arquivo` para ela via loopback, não reescrever nada em Supabase.
vi.mock('axios');

vi.mock('../config', () => ({
  config: {
    port: 3000,
    apiSecret: 'segredo-teste',
    supabaseUrl: 'https://ipgewsdujovghxbwisvr.supabase.co',
    supabaseServiceKey: 'service-key-teste',
    openaiApiKey: 'sk-teste',
  },
}));

import { handleEnviarArquivo } from './handlers';

describe('handleEnviarArquivo', () => {
  beforeEach(() => {
    vi.mocked(axios.post).mockReset();
    vi.mocked(axios.isAxiosError).mockReturnValue(false);
  });

  const ctx = {
    agent_id: 'b63f50d1-4e37-4ab2-a164-3e53d1eb7d6e',
    conversation_id: 'conv-1',
    contact_phone: '5583999990000',
  };

  it('chama /api/send-external (loopback), não a function morta send-media', async () => {
    vi.mocked(axios.post).mockResolvedValue({
      status: 200,
      data: { ok: true, message_id: 'msg-1', status: 'sent' },
    });

    await handleEnviarArquivo({ file_url: 'https://cdn.exemplo.com/foto.jpg' }, ctx);

    expect(axios.post).toHaveBeenCalledTimes(1);
    const [url] = vi.mocked(axios.post).mock.calls[0];
    expect(url).toBe('http://localhost:3000/api/send-external');
    expect(url).not.toContain('send-media');
  });

  it('manda agent_id, contact_phone e media_url no payload, autenticado com API_SECRET', async () => {
    vi.mocked(axios.post).mockResolvedValue({ status: 200, data: { ok: true } });

    await handleEnviarArquivo({ file_url: 'https://cdn.exemplo.com/foto.jpg' }, ctx);

    const [, body, options] = vi.mocked(axios.post).mock.calls[0];
    expect(body).toMatchObject({
      agent_id: ctx.agent_id,
      phone: ctx.contact_phone,
      media_url: 'https://cdn.exemplo.com/foto.jpg',
    });
    expect((options as { headers: Record<string, string> }).headers.Authorization).toBe(
      'Bearer segredo-teste',
    );
  });

  it.each([
    ['https://cdn.exemplo.com/foto.jpg', 'image'],
    ['https://cdn.exemplo.com/foto.PNG', 'image'],
    ['https://cdn.exemplo.com/video.mp4', 'video'],
    ['https://cdn.exemplo.com/audio.mp3', 'audio'],
    ['https://cdn.exemplo.com/audio.ogg', 'audio'],
    ['https://cdn.exemplo.com/laudo.pdf', 'document'],
    ['https://cdn.exemplo.com/arquivo-sem-extensao', 'document'],
  ])('infere type=%s a partir da extensão de %s', async (file_url, esperado) => {
    vi.mocked(axios.post).mockResolvedValue({ status: 200, data: { ok: true } });

    await handleEnviarArquivo({ file_url }, ctx);

    const [, body] = vi.mocked(axios.post).mock.calls[0] as [string, { type: string }];
    expect(body.type).toBe(esperado);
  });
});
