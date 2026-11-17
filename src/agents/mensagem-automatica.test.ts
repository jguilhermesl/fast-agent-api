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
    // 14/11/2026: saudação de conta comercial respondendo ao follow-up da Duda (card #1419).
    'velas e sabonetes artesanal agradece seu contato. Como podemos ajudar?',
    // 13/11/2026: encaminhamento automático de empresa para atendente.
    'Vamos te direcionar para um de nossos atendentes.\n• Horário de atendimento: segunda a sexta, das 9h às 18h( horário de Brasília, exceto feriados).\n• Se o contato ocorrer próximo ao fim do horário, o atendimento pode não ser concluído , nesse caso, fale conosco novamente no próximo dia útil.',
    // 28/10/2026 (card #1223): atendimento automático da B4 Telecom, que a Duda respondeu 17 vezes.
    'Atendimento finalizado, agradecemos o contato',
    'Seja bem-vindo a central de atendimento da *B4 TELECOM*🚀🚀🚀\n\nPara iniciarmos seu atendimento, por favor me informe *seu nome*.',
    'Seja bem-vindo a central de atendimento da *B4 TELECOM*🚀🚀🚀\n\nPara que eu possa lhe ajudar, escolha uma das opções abaixo pelo número correspondente:\n\n *[ 1 ]* - *Já sou cliente*\n *[ 2 ]* - *Não sou cliente*',
    'Opção não encontrada, por favor, escolha uma das opções do menu (Digite somente o número da opção).\n                        \n *[ 1 ]* - *Já sou cliente*\n *[ 2 ]* - *Não sou cliente*',
    // Outros menus de empresa dos mesmos 30 dias (Carol, Duda).
    'Escolha uma das seguintes opções:\n*2* *-* 🔘 Agendamento\n*1* *-* 🩻 Resultado de exame\n*3* *-* ⁉️ Dúvidas e informações\nDigite #inicio para voltar ao menu principal',
    'Olá LP SAÚDE RIO DOCE! Seja muito bem vindo (a) ao atendimento digital da *LP Benéficios*\nDigite o *número* da opção abaixo para o que deseja:\n*1* - Quero me tornar cliente\n*2* - Já sou cliente',
    'Olá! Seja bem vindo ao atendimento Alvaro Apoio. 😊 Para seguirmos com seu atendimento, escolha a opção que melhor descreve sua relação com Alvaro Apoio: 1- Alvaro Apoio 2- Laboratório parceiro',
    'Agora, por favor, selecione qual desses serviços melhor atende à sua necessidade: 1 - Conexão Alvaro Apoio 2 - Financeiro 3 - Assessoria Científica 4 - Encerrar',
    'Eu não estou conseguindo entender sobre o quê você gostaria de conversar 🙁. Para ver todos os serviços oferecidos, digite a palavra *menu*',
    'Atendimento finalizado com sucesso. Segue seu protocolo: 592239624.',
    'Como você avalia o meu atendimento?\n*5* – *_Muito satisfeito_* 🤩\n*4* – *_Satisfeito_* 😍\n*3* – *_Neutro_* 😐\n*2* – *_Insatisfeito_* 🥺\n*1* – *_Muito insatisfeito_* 😔',
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
    'Como podemos fazer para agendar?',
    'Vocês podem me ajudar? Agradeço o contato',
    'Qual o horário de atendimento: de manhã ou de tarde?',
    'Vocês abrem no sábado ou é exceto feriados?',
    // Frases de gente que encostam nos sinais de menu (17/11/2026).
    'Tentei marcar pelo site e deu opção inválida',
    'O atendimento foi encerrado e eu não consegui marcar',
    'Meu protocolo é 592239624, podem verificar?',
    'Preciso desses exames:\n1. hemograma\n2. glicemia\n3. TSH',
    'Qual vocês indicam? 1- ultrassom 2- ressonância',
    'Protocolo:1293947 Bom dia. Sou a Valéria da Tem Saúde. Gostaria de agendar uma consulta com endocrinologia, por favor.',
    'Nome : Ana Paula 996660818 18/11/76 49 anos\n2-R: sim, diabetes\n3- R - asmática\n4- não\n5-sim',
    'Remarcar terça quinta ou sábado (81) 9379-8103 (81) 98647-0542 (81) 9440-8751',
    'Pode escolher o melhor horário pra mim',
    'Consulta dia 12/10 às 10:30 ou 1.500 de entrada?',
    // Revisão do Codex (17/11/2026): gente citando o menu para pedir ajuda.
    "Tentei agendar e apareceu 'opção inválida, digite somente o número'. O que faço?",
    "Agora apareceu 'digite menu'. Vocês conseguem marcar pra mim?",
    'Recebi essa mensagem: Digite 1 para falar com o financeiro. É de vocês?',
    'Me mandaram isso: Seja bem-vindo a central de atendimento, escolha uma das opções. Como eu marco?',
  ])('paciente: %s', (m) => expect(pareceMensagemAutomatica(m)).toBe(false));

  it('revisão do Codex: "1" seguido de 50 mil espaços não trava a CPU', () => {
    const texto = '1' + ' '.repeat(50_000) + 'x';
    const inicio = performance.now();
    expect(pareceMensagemAutomatica(texto)).toBe(false);
    expect(performance.now() - inicio).toBeLessThan(300);
  });
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
