import { describe, it, expect, vi } from 'vitest';
vi.mock('../../services/supabase', () => ({ supabase: { from: vi.fn() }, logGuardShadow: vi.fn() }));
import { montarPromptDoBanco } from './prompt-do-banco';

describe('montarPromptDoBanco (demonstração sem system_prompt)', () => {
  it('lê o agente com ids nulos de conversa e lead e devolve o texto do montador', async () => {
    const carregar = vi.fn().mockResolvedValue({ promptConfig: {}, treinamentos: [] });
    const montar = vi.fn().mockReturnValue('PROMPT MONTADO');
    const texto = await montarPromptDoBanco('agente-1', '5581999990000', { carregar, montar } as never);
    expect(texto).toBe('PROMPT MONTADO');
    const p = carregar.mock.calls[0][0];
    expect(p.agentId).toBe('agente-1');
    expect(p.conversationId).toBe('00000000-0000-0000-0000-000000000000');
    expect(p.leadId).toBe('00000000-0000-0000-0000-000000000000');
    expect(p.contatoTelefone).toBe('5581999990000');
    expect(montar).toHaveBeenCalledWith({ promptConfig: {}, treinamentos: [] });
  });

  it('propaga o erro do carregamento (agente inexistente)', async () => {
    const carregar = vi.fn().mockRejectedValue(new Error('agents: agente x não encontrado'));
    await expect(montarPromptDoBanco('x', '1', { carregar, montar: vi.fn() } as never)).rejects.toThrow('não encontrado');
  });
});
