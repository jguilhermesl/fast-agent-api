import { describe, it, expect } from 'vitest';
import { decidirLoopRobo, decidirLoopLento, decidirLoopRoboTurno, decidirRoboNoRabo, normalizarTexto, type MensagemDaLinha, type MensagemRecebida } from './loop-robo';
import { pareceMensagemAutomatica } from './mensagem-automatica';

const texto = (content: string): MensagemRecebida => ({ message_type: 'text', content });
const varios = (n: number, f: (i: number) => string) => Array.from({ length: n }, (_, i) => texto(f(i)));
const AUTOMATICA = "Hello, I'm sorry we cannot provide you with services for the time being. Please stay tuned.";

describe('decidirLoopRobo', () => {
  it('caso Carol 08/10: a mesma resposta automática 10 vezes na hora é loop', () => {
    expect(decidirLoopRobo(varios(10, () => AUTOMATICA))).toEqual({ loop: true, textos: 10, distintos: 1, regra: 'repeticao' });
  });

  it('9 repetições ainda não é loop', () => {
    expect(decidirLoopRobo(varios(9, () => AUTOMATICA)).loop).toBe(false);
  });

  it('espaço e maiúscula diferentes contam como o mesmo texto', () => {
    const msgs = varios(10, (i) => (i % 2 ? AUTOMATICA.toUpperCase() : `  ${AUTOMATICA.replace(/ /g, '  ')} `));
    expect(decidirLoopRobo(msgs)).toMatchObject({ loop: true, distintos: 1 });
  });

  it('duas frases alternadas 10 vezes é loop', () => {
    expect(decidirLoopRobo(varios(10, (i) => (i % 2 ? 'Mensagem automática A' : 'Mensagem automática B')))).toMatchObject({ loop: true, distintos: 2 });
  });

  it('três frases em 10 mensagens não é loop pela 1ª regra', () => {
    expect(decidirLoopRobo(varios(10, (i) => `frase ${i % 3}`)).loop).toBe(false);
  });

  it('caso Carol 09/10: 63 mensagens com 4 frases é loop (poucas frases)', () => {
    expect(decidirLoopRobo(varios(63, (i) => `aviso ${i % 4}`))).toEqual({ loop: true, textos: 63, distintos: 4, regra: 'poucas_frases' });
  });

  it('20 mensagens com 3 frases ainda não é loop; 24 é', () => {
    expect(decidirLoopRobo(varios(20, (i) => `aviso ${i % 3}`)).loop).toBe(false);
    expect(decidirLoopRobo(varios(24, (i) => `aviso ${i % 3}`)).loop).toBe(true);
  });

  it('a hora humana mais cheia dos 30 dias (46 mensagens, 44 diferentes) passa', () => {
    expect(decidirLoopRobo(varios(46, (i) => (i < 3 ? 'ok' : `pergunta número ${i}`))).loop).toBe(false);
  });

  it('41 mensagens com 25 diferentes passa', () => {
    expect(decidirLoopRobo(varios(41, (i) => `msg ${i % 25}`)).loop).toBe(false);
  });

  it('áudio, foto e figurinha não contam (caso Duda: 38 áudios seguidos)', () => {
    const midia: MensagemRecebida[] = [
      ...Array.from({ length: 38 }, () => ({ message_type: 'audio', content: '' })),
      ...Array.from({ length: 16 }, () => ({ message_type: 'image', content: null })),
      ...Array.from({ length: 18 }, () => ({ message_type: 'sticker', content: '' })),
    ];
    expect(decidirLoopRobo(midia)).toEqual({ loop: false, textos: 0, distintos: 0 });
  });

  it('texto de 1 caractere não conta ("?" repetido por gente impaciente)', () => {
    expect(decidirLoopRobo(varios(15, () => '?')).loop).toBe(false);
  });

  it('"oi" repetido 10 vezes conta (2 caracteres)', () => {
    expect(decidirLoopRobo(varios(10, () => 'oi')).loop).toBe(true);
  });

  it('sem mensagens não é loop', () => {
    expect(decidirLoopRobo([])).toEqual({ loop: false, textos: 0, distintos: 0 });
  });
});

describe('normalizarTexto', () => {
  it('junta espaços, tira as pontas e passa para minúscula', () => {
    expect(normalizarTexto('  Olá   TUDO\n bem ')).toBe('olá tudo bem');
  });
});

describe('loop lento (24 h)', () => {
  const AGORA = Date.parse('2026-11-17T12:00:00Z');
  const em = (minAtras: number, content: string): MensagemRecebida => ({
    message_type: 'text',
    content,
    created_at: new Date(AGORA - minAtras * 60_000).toISOString(),
  });
  const CLARO = 'Em caso de dúvidas ou para mais informações, acesse sua conta: https://minhaclaro.claro.com.br/x';

  it('caso Diana/Claro: 1 texto a cada 11 min por 2 dias pausa (a regra da hora sozinha não pega)', () => {
    const msgs = Array.from({ length: 200 }, (_, i) => em(i * 11, CLARO));
    const naHora = msgs.filter((m) => Date.parse(m.created_at!) >= AGORA - 3_600_000);
    expect(decidirLoopRobo(naHora).loop).toBe(false);
    expect(decidirLoopRoboTurno(msgs, AGORA)).toMatchObject({ loop: true, regra: 'lento', distintos: 1 });
  });

  it('23 textos iguais em 24 h ainda não; 24 sim', () => {
    expect(decidirLoopRoboTurno(Array.from({ length: 23 }, (_, i) => em(i * 60, CLARO)), AGORA).loop).toBe(false);
    expect(decidirLoopRoboTurno(Array.from({ length: 24 }, (_, i) => em(i * 55, CLARO)), AGORA).loop).toBe(true);
  });

  it('duas frases alternadas lentas pausam; três não', () => {
    expect(decidirLoopRoboTurno(Array.from({ length: 30 }, (_, i) => em(i * 45, i % 2 ? 'Claro Clube A' : 'Claro Clube B')), AGORA).loop).toBe(true);
    expect(decidirLoopRoboTurno(Array.from({ length: 30 }, (_, i) => em(i * 45, `aviso ${i % 3}`)), AGORA).loop).toBe(false);
  });

  it('paciente real com ok/sim/bom dia espalhados em 24 h não pausa', () => {
    const msgs = Array.from({ length: 60 }, (_, i) => em(i * 20, i % 4 === 0 ? 'ok' : i % 4 === 1 ? 'sim' : i % 4 === 2 ? 'bom dia' : `pergunta ${i}`));
    expect(decidirLoopRoboTurno(msgs, AGORA).loop).toBe(false);
  });

  it('só "ok", "sim" e "bom dia" em quantidade baixa (10 em 24 h) não pausa', () => {
    const msgs = Array.from({ length: 10 }, (_, i) => em(i * 120, ['ok', 'sim', 'bom dia'][i % 3]));
    expect(decidirLoopRoboTurno(msgs, AGORA).loop).toBe(false);
  });

  it('confirmação repetida de paciente ("confirmo" 5 vezes no dia) não pausa', () => {
    const msgs = Array.from({ length: 5 }, (_, i) => em(i * 240, 'confirmo'));
    expect(decidirLoopRoboTurno(msgs, AGORA).loop).toBe(false);
  });

  it('regra da hora continua igual com mensagens datadas: 10 iguais na hora pausam', () => {
    const msgs = Array.from({ length: 10 }, (_, i) => em(i * 5, CLARO));
    expect(decidirLoopRoboTurno(msgs, AGORA)).toEqual({ loop: true, textos: 10, distintos: 1, regra: 'repeticao' });
  });

  it('10 iguais espalhadas em 24 h (fora da hora) não pausam', () => {
    const msgs = Array.from({ length: 10 }, (_, i) => em(90 + i * 100, CLARO));
    expect(decidirLoopRoboTurno(msgs, AGORA).loop).toBe(false);
  });

  it('áudio e texto de 1 caractere não contam no loop lento', () => {
    const msgs: MensagemRecebida[] = [
      ...Array.from({ length: 40 }, (_, i) => ({ message_type: 'audio', content: '', created_at: new Date(AGORA - i * 600_000).toISOString() })),
      ...Array.from({ length: 40 }, (_, i) => em(i * 30, '?')),
    ];
    expect(decidirLoopLento(msgs).loop).toBe(false);
  });
});

describe('robô reconhecido pelo rabo da conversa (card #1223)', () => {
  const cliente = (content: string | null, message_type = 'text'): MensagemDaLinha => ({ direction: 'inbound', message_type, content });
  const ia = (content = 'resposta da IA'): MensagemDaLinha => ({ direction: 'outbound', message_type: 'text', content });
  const sistema = (): MensagemDaLinha => ({ direction: 'outbound', message_type: 'system', content: 'Conversa devolvida para a IA' });
  const ultimaRecebida = (linha: MensagemDaLinha[]) => [...linha].reverse().find((m) => m.direction === 'inbound')?.content ?? '';
  /** Por padrão a fala do turno é a última recebida, como no fluxo real; `turno` simula leitura atrasada. */
  const decidir = (linha: MensagemDaLinha[], turno?: string) => decidirRoboNoRabo(linha, pareceMensagemAutomatica, turno ?? ultimaRecebida(linha));
  const vezes = <T>(n: number, f: () => T[]): T[] => Array.from({ length: n }, f).flat();

  const FINALIZADO = 'Atendimento finalizado, agradecemos o contato';
  const BOAS_VINDAS = 'Seja bem-vindo a central de atendimento da *B4 TELECOM*🚀🚀🚀\n\nPara iniciarmos seu atendimento, por favor me informe *seu nome*.';
  const MENU = 'Seja bem-vindo a central de atendimento da *B4 TELECOM*🚀🚀🚀\n\nPara que eu possa lhe ajudar, escolha uma das opções abaixo pelo número correspondente:\n\n *[ 1 ]* - *Já sou cliente*\n *[ 2 ]* - *Não sou cliente*';
  const NAO_ENCONTRADA = 'Opção não encontrada, por favor, escolha uma das opções do menu (Digite somente o número da opção).\n                        \n *[ 1 ]* - *Já sou cliente*\n *[ 2 ]* - *Não sou cliente*';
  const CLARO = 'Em caso de dúvidas ou para mais informações, acesse sua conta: https://minhaclaro.claro.com.br/acesso-rapido/ ou, se preferir, mande uma mensagem';
  const PERGUNTA = 'Boa tarde, gostaria de saber o valor da ressonância do joelho e se tem vaga ainda essa semana';

  // Conversa real de 28/10/2026 (Duda x B4 Telecom): a Sabrina conversou, o atendimento dela
  // foi encerrado e o menu automático da empresa passou a responder a Duda.
  const SABRINA: MensagemDaLinha[] = [
    cliente('bom dia'),
    cliente('Aqui é a Sabrina da B4 TELECOM, gostaria de saber os valores dos exames asu'),
    ia(), ia(),
    cliente('tudo bem'), ia(),
    cliente('estou esperando a resposta da diretoria'), ia(),
    cliente('agradeço.'), ia(),
  ];

  describe('mensagens automáticas seguidas', () => {
    it('B4: a primeira mensagem automática ainda passa (uma só não cala a IA)', () => {
      expect(decidir([...SABRINA, cliente(FINALIZADO)]).loop).toBe(false);
    });

    it('B4: respondemos a primeira e veio outra automática: pausa, antes do menu se repetir', () => {
      expect(decidir([...SABRINA, cliente(FINALIZADO), ia(), cliente(BOAS_VINDAS)])).toEqual({ loop: true, textos: 2, distintos: 2, regra: 'automaticas' });
    });

    it('B4: com a IA pausada, o menu e a opção não encontrada continuam pausados', () => {
      const linha = [...SABRINA, cliente(FINALIZADO), ia(), cliente(BOAS_VINDAS), cliente(MENU), cliente(NAO_ENCONTRADA), cliente(NAO_ENCONTRADA)];
      expect(decidir(linha)).toMatchObject({ loop: true, regra: 'automaticas', textos: 5 });
    });

    it('B4: as regras de repetição sozinhas não pegavam (9 textos diferentes na hora)', () => {
      const recebidas = [...SABRINA, cliente(FINALIZADO), cliente(BOAS_VINDAS), cliente(MENU), ...Array.from({ length: 8 }, () => cliente(NAO_ENCONTRADA))]
        .filter((m) => m.direction === 'inbound');
      expect(decidirLoopRoboTurno(recebidas).loop).toBe(false);
    });

    it('a pessoa voltou a falar depois do robô: a IA responde', () => {
      const linha = [...SABRINA, cliente(FINALIZADO), ia(), cliente(BOAS_VINDAS), cliente(MENU), cliente('Oi, a diretoria aprovou, pode agendar')];
      expect(decidir(linha).loop).toBe(false);
    });

    it('pergunta de gente sem resposta + duas automáticas do WhatsApp dela: a IA responde', () => {
      const linha = [ia('Oi! Conseguiu ver os horários?'), cliente('Quanto custa a consulta com cardiologista?'), cliente(BOAS_VINDAS), cliente(MENU)];
      expect(decidir(linha).loop).toBe(false);
    });

    it('duas automáticas de uma vez, sem resposta nossa no meio, ainda passam; a seguinte, depois da resposta, pausa', () => {
      const SHOPEE = 'Olá Agradecemos seu contato! Este é o WhatsApp oficial da Shopee. Como podemos ajudar?';
      expect(decidir([cliente(SHOPEE), cliente(MENU)]).loop).toBe(false);
      expect(decidir([cliente('Quanto custa a consulta?'), ia('R$ 150,00'), cliente(BOAS_VINDAS), cliente(MENU)]).loop).toBe(false);
      expect(decidir([cliente(SHOPEE), cliente(MENU), ia(), cliente(NAO_ENCONTRADA)])).toMatchObject({ loop: true, regra: 'automaticas', textos: 3 });
    });

    it('áudio ou foto entre as automáticas é sinal de gente: não pausa', () => {
      expect(decidir([cliente(FINALIZADO), ia(), cliente('', 'audio'), cliente(BOAS_VINDAS)]).loop).toBe(false);
      expect(decidir([cliente(FINALIZADO), ia(), cliente(BOAS_VINDAS), cliente(null, 'image')]).loop).toBe(false);
    });

    it('paciente que encaminha UMA mensagem automática e pergunta sobre ela: a IA responde', () => {
      const linha = [cliente('Olá Francisco, esta é uma mensagem automática da empresa. Para não receber novas mensagens, selecione Parar.'), ia(), cliente('Não está aparecendo o QR código!?')];
      expect(decidir(linha).loop).toBe(false);
    });

    it('revisão do Codex: paciente reclamando do menu, citando as frases, não é robô (nem com resposta nossa no meio)', () => {
      const R1 = "Tentei agendar e apareceu 'opção inválida, digite somente o número'. O que faço?";
      const R2 = "Agora apareceu 'digite menu'. Vocês conseguem marcar pra mim?";
      expect(decidir([cliente(R1), cliente(R2)]).loop).toBe(false);
      expect(decidir([cliente(R1), ia(), cliente(R2)]).loop).toBe(false);
    });

    it('revisão do Codex: leitura do banco atrasada, a pessoa acabou de escrever: o turno segue', () => {
      const linha = [cliente(FINALIZADO), ia(), cliente('Digite menu para continuar')];
      expect(decidir(linha).loop).toBe(true);
      expect(decidir(linha, 'Oi, sou a Maria, pode agendar amanhã?').loop).toBe(false);
    });

    it('2ª revisão do Codex: lote "menu + pedido de gente" com leitura atrasada: o turno segue', () => {
      const linha = [cliente(FINALIZADO), ia(), cliente('Digite menu para continuar')];
      expect(decidir(linha, 'Digite menu para continuar\nPreciso cancelar minha consulta de amanhã').loop).toBe(false);
      expect(decidir(linha, 'Digite menu para continuar\nVocês conseguem cancelar pra mim?').loop).toBe(false);
    });

    it('lote só com mensagens automáticas da sequência (o n8n juntou duas) continua pausando', () => {
      const linha = [...SABRINA, cliente(FINALIZADO), ia(), cliente(BOAS_VINDAS), cliente(MENU)];
      expect(decidir(linha, `${BOAS_VINDAS}\n${MENU}`)).toMatchObject({ loop: true, regra: 'automaticas', textos: 3 });
      expect(decidir(linha, '').loop).toBe(false);
    });

    it('3ª revisão do Codex: lista numerada escrita pela pessoa, citando o menu, não pausa', () => {
      const L1 = '1 - Recebi essa mensagem: Digite menu para continuar\n2 - Vocês conseguem marcar minha consulta?';
      const L2 = '1 - Apareceu: Escolha uma das opções\n2 - Me ajudem a cancelar minha consulta';
      expect(decidir([cliente(L1), ia('Como posso ajudar?'), cliente(L2)]).loop).toBe(false);
    });

    it('a fala do turno tem de ser o fim da sequência: as últimas mensagens dela, coladas na ordem', () => {
      const A = 'Digite menu para continuar';
      const B = `${A}\nDigite menu`;
      const C = 'Digite menu para falar com atendente';
      const linha = [cliente(A), ia(), cliente(B), ia(), cliente(C)];
      expect(decidir(linha, C)).toMatchObject({ loop: true, regra: 'automaticas', textos: 3 });
      expect(decidir(linha, `${B}\n${C}`).loop).toBe(true);
      expect(decidir(linha, `  ${B.toUpperCase()}\n\n${C}  `).loop).toBe(true);
      // Não é o fim da sequência (A já foi respondida em outro turno) ou tem texto a mais: o turno segue.
      expect(decidir(linha, `${A}\n${C}`).loop).toBe(false);
      expect(decidir(linha, `${C} por favor`).loop).toBe(false);
      expect(decidir(linha, 'Digite menu').loop).toBe(false);
    });

    it('4ª revisão do Codex: paciente que numera as perguntas e cita o plano não é robô', () => {
      const P1 = 'Meu plano é Bradesco.\n1 - Vocês atendem cardiologia?\n2 - Preciso agendar para amanhã.';
      const P2 = 'Bradesco Saúde:\n1 - Vocês aceitam meu plano?\n2 - Podem marcar a consulta?';
      expect(decidir([cliente(P1), ia('Como posso ajudar?'), cliente(P2)]).loop).toBe(false);
    });

    it('5ª revisão do Codex: paciente pedindo avaliação de exames em lista numerada não é robô', () => {
      const E1 = 'Como você avalia esses resultados?\n1 - Glicose: 180\n2 - Colesterol: 240';
      const E2 = 'Como você avalia esses exames?\n1 - Hemoglobina: 10\n2 - Ferritina: 8';
      expect(decidir([cliente(E1), ia('Vou verificar.'), cliente(E2)]).loop).toBe(false);
    });

    it('5ª revisão do Codex: menu colado com a pergunta da pessoa depois do último item não é robô', () => {
      const M1 = 'Escolha uma das opções:\n1 - Consulta\n2 - Exame. Vocês fazem ultrassom?';
      const M2 = 'Digite o número da opção:\n1 - Ultrassom\n2 - Ressonância. Tentei agendar, podem me ajudar?';
      expect(decidir([cliente(M1), ia('Como posso ajudar?'), cliente(M2)]).loop).toBe(false);
    });

    it('4ª revisão do Codex: texto montado com 38 prefixos longos não custa segundos de CPU', () => {
      const S = 'Digite menu ';
      const K = Math.floor(65_000 / S.length);
      const linha = [cliente(S.trim()), ia(), ...Array.from({ length: 38 }, (_, i) => cliente(S.repeat(Math.floor(K * (0.5 + i * 0.012))).trim()))];
      const inicio = performance.now();
      decidir(linha, S.repeat(K).trim());
      expect(performance.now() - inicio).toBeLessThan(500);
    });

    it('mensagem de sistema no meio não muda a decisão', () => {
      expect(decidir([...SABRINA, cliente(FINALIZADO), ia(), sistema(), cliente(BOAS_VINDAS)])).toMatchObject({ loop: true, regra: 'automaticas' });
    });

    it('10 automáticas seguidas pausam mesmo sem resposta nossa à vista; 9 não', () => {
      // Textos alternados: 10 iguais cairiam na regra de eco.
      const alternadas = (n: number) => Array.from({ length: n }, (_, i) => cliente(i % 2 ? MENU : BOAS_VINDAS));
      expect(decidir([ia(), ...alternadas(9)]).loop).toBe(false);
      expect(decidir([ia(), ...alternadas(10)])).toEqual({ loop: true, textos: 10, distintos: 2, regra: 'automaticas' });
    });
  });

  describe('eco', () => {
    it('Claro: respondemos e o mesmo texto longo voltou pela quinta vez', () => {
      expect(decidir([...vezes(4, () => [cliente(CLARO), ia()]), cliente(CLARO)])).toEqual({ loop: true, textos: 5, distintos: 1, regra: 'eco' });
    });

    it('quatro vezes ainda não', () => {
      expect(decidir([...vezes(3, () => [cliente(CLARO), ia()]), cliente(CLARO)]).loop).toBe(false);
    });

    it('revisão do Codex: paciente que cola a mesma pergunta longa depois de respostas ruins continua atendido', () => {
      expect(decidir([cliente(PERGUNTA), ia('Qual exame deseja?'), cliente(PERGUNTA), ia('Como posso ajudar?'), cliente(PERGUNTA)]).loop).toBe(false);
      expect(decidir([...vezes(3, () => [cliente(PERGUNTA), ia('Como posso ajudar?')]), cliente(PERGUNTA)]).loop).toBe(false);
    });

    it('com a IA pausada a sequência cresce e a pausa continua', () => {
      const linha = [...vezes(4, () => [cliente(CLARO), ia()]), ...vezes(6, () => [cliente(CLARO)])];
      expect(decidir(linha)).toMatchObject({ loop: true, regra: 'eco', textos: 10 });
    });

    it('revisão do Codex: pausa longa, a nossa última saída sai do recorte de 40 e a pausa continua', () => {
      expect(decidir([cliente(CLARO), ia(), ...vezes(38, () => [cliente(CLARO)])])).toMatchObject({ loop: true, regra: 'eco' });
      expect(decidir([ia(), ...vezes(39, () => [cliente(CLARO)])])).toMatchObject({ loop: true, regra: 'eco', textos: 39 });
      expect(decidir(vezes(40, () => [cliente(CLARO)]))).toMatchObject({ loop: true, regra: 'eco', textos: 40 });
    });

    it('a mesma pergunta longa colada 5 vezes sem resposta nossa no meio não pausa', () => {
      expect(decidir([ia('Oi!'), ...vezes(5, () => [cliente(PERGUNTA)])]).loop).toBe(false);
    });

    it('texto curto repetido não pausa (casos reais: "pode mandar" e o texto do anúncio)', () => {
      const ANUNCIO = 'Olá! Tenho interesse em agendar uma consulta, por favor.';
      expect(decidir([...vezes(5, () => [cliente('pode mandar'), ia()]), cliente('pode mandar')]).loop).toBe(false);
      expect(decidir([...vezes(5, () => [cliente(ANUNCIO), ia()]), cliente(ANUNCIO)]).loop).toBe(false);
    });

    it('texto diferente no meio quebra a sequência', () => {
      expect(decidir([...vezes(4, () => [cliente(CLARO), ia()]), cliente('oi, é a Maria'), ia(), cliente(CLARO)]).loop).toBe(false);
    });

    it('leitura do banco atrasada: o recorte mostra o eco, mas a fala do turno é outra', () => {
      const linha = [...vezes(4, () => [cliente(CLARO), ia()]), cliente(CLARO)];
      expect(decidir(linha, 'Bom dia, quero remarcar minha consulta').loop).toBe(false);
      expect(decidir(linha, `${CLARO}\n${CLARO}`).loop).toBe(true);
      // 2ª revisão do Codex: lote "texto do robô + pedido de gente" não pode ser calado.
      expect(decidir(linha, `${CLARO}\nVocês conseguem cancelar pra mim?`).loop).toBe(false);
      expect(decidir(linha, `${CLARO}\nPreciso cancelar minha consulta de amanhã`).loop).toBe(false);
    });
  });

  it('sem mensagem recebida não pausa', () => {
    expect(decidir([])).toEqual({ loop: false, textos: 0, distintos: 0 });
    expect(decidir([ia()])).toEqual({ loop: false, textos: 0, distintos: 0 });
  });
});
