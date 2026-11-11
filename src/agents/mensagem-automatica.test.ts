import { describe, it, expect } from 'vitest';
import { pareceMensagemAutomatica } from './mensagem-automatica';
import { parseOrchestratorOutput, MENSAGEM_INSTABILIDADE } from './saida';

// 04–05/11/2026, Duda: 4 transferências "Resposta vazia do modelo". Todas eram robô de empresa
// (Bradesco, cartão ELO, "Kit Festa"): a persona manda não responder, o modelo devolvia vazio,
// e o código mandava "Desculpe, estou com uma instabilidade" ao robô e transferia à recepção.
describe('pareceMensagemAutomatica', () => {
  it.each([
    'Olá, CVS SERVICOS. Há informações contratuais atualizadas referentes ao seu contrato BRADESCO.\n\nPara verificar os detalhes, utilize a opção abaixo.\n\nPara não receber novas mensagens, selecione Parar mensagens.',
    'Regularize com condições especiais seu(s) cartão(ões) *EMPRESARIAL ELO MAIS* com atraso de 85 dias. Caso tenha realizado o pagamento desconsidere. Vamos iniciar a simulação?',
    '*Resposta Automática* \nOlá! Gilda Kit Festa Agradecemos Seu Contato Vou Lhe Mandar A Tabela!',
    'Olá CAIO, há uma atualização disponível sobre o seu cartao Bradesco. Se precisar de mais informações, estamos à disposição.',
    'Digite 1 para falar com o financeiro ou 2 para suporte',
    // 11/11/2026: ausência de conta comercial respondendo ao follow-up da Duda.
    'Olá, aqui é da Recruta Fardamentos 🌟\n‼️No momento não estamos mais disponíveis para atendimento. Por favor deixe sua mensagem que retornaremos assim que possível.\n\n\n⏰ Nosso horário de atendimento é de segunda a sexta das 08:30 às 17:30 e no sábado das 08:00 às 12:00.',
    // 09/11/2026: convite de aplicativo.
    'Convide amigos para entrar no TikTok Lite usando seu código e ganhe recompensas! https://www.tiktok.com/d/4/ZS9fka682RCyv-ULnLx/',
    'No momento não estamos disponíveis. Deixe sua mensagem.',
    // Texto padrão de ausência do WhatsApp Business (5 vezes na Duda em 30 dias).
    'Agradecemos sua mensagem. Não estamos disponíveis no momento, mas responderemos assim que possível.',
    'Seja bem vindo! 😊\n\nA Gastro.PE Olinda agradece seu contato. Responderemos dentro de instantes.',
    'Obrigado pelo contato! Nosso horário de funcionamento é das 8h às 18h. Responderemos em breve.',
  ])('robô: %s', (m) => expect(pareceMensagemAutomatica(m)).toBe(true));

  it.each([
    'Boa tarde, quanto custa o hemograma?',
    'Obrigada!',
    'Meu plano é Bradesco Saúde, vocês aceitam?',
    'Recebi a mensagem automática de vocês, quero agendar',
    'Pode me mandar a tabela de preços?',
    'Qual o horário de atendimento de vocês?',
    'Vi esse vídeo de vocês https://www.tiktok.com/@lpsaude/video/123 fazem esse exame?',
    'Não estou disponível nesse dia, tem outro?',
    'Vou deixar minha mensagem aqui, me retornem quando puderem',
    'Minha amiga me convidou, ganhei um desconto?',
  ])('paciente: %s', (m) => expect(pareceMensagemAutomatica(m)).toBe(false));
});

describe('silêncio só para robô', () => {
  it('vazio sem transferir + robô do outro lado: silêncio, sem instabilidade e sem transferência', () => {
    expect(parseOrchestratorOutput('{"mensagens":[],"redirect_human":false}', false, true)).toEqual({ mensagens: [], redirect_human: false });
  });
  it('vazio sem transferir + paciente: continua protegendo (instabilidade + transferência)', () => {
    const r = parseOrchestratorOutput('{"mensagens":[],"redirect_human":false}', false, false);
    expect(r.mensagens).toEqual([MENSAGEM_INSTABILIDADE]);
    expect(r.redirect_human).toBe(true);
  });
  it('vazio pedindo transferência continua com a linha antes do humano, mesmo com robô', () => {
    expect(parseOrchestratorOutput('{"mensagens":[""],"redirect_human":true,"transfer_reason":"x"}', false, true).redirect_human).toBe(true);
  });
});
