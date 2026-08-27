// ============================================================
// Smoke test HTTP — o serviço sobe e responde como deve
// ============================================================
//
//   npx tsx scripts/smoke-http.ts
//
// Monta os routers reais numa porta efêmera com credenciais falsas e bate neles.
// Nada aqui toca produção: a chave da OpenAI é inválida de propósito, o Supabase
// aponta para uma porta fechada e o Redis também. É exatamente o ponto — o que
// se quer provar é que provider caído vira resposta degradada e nunca 500 nem
// stack trace no cliente.

// Atribuição incondicional, nunca `??=`. Na primeira versão deste script as
// credenciais eram opcionais e a OPENAI_API_KEY real já estava no ambiente da
// máquina: o smoke chamou a OpenAI de verdade e queimou tokens. Sobrescrever é
// a única forma de garantir que nenhum provider real seja tocado.
process.env.API_SECRET           = 'smoke-secret';
process.env.OPENAI_API_KEY       = 'sk-invalida-de-proposito';
process.env.ANTHROPIC_API_KEY    = 'sk-ant-invalida';
process.env.SUPABASE_URL         = 'http://127.0.0.1:9';
process.env.SUPABASE_ANON_KEY    = 'anon-falsa';
process.env.SUPABASE_SERVICE_KEY = 'service-falsa';
process.env.WEBHOOK_SECRET       = 'webhook-falso';
process.env.REDIS_URL            = 'redis://127.0.0.1:6399';

/* eslint-disable @typescript-eslint/no-var-requires */
const express = require('express') as typeof import('express');
const { chatRouter } = require('../src/routes/chat') as typeof import('../src/routes/chat');
const { stagesRouter } = require('../src/routes/stages') as typeof import('../src/routes/stages');
const { typingRouter } = require('../src/routes/typing') as typeof import('../src/routes/typing');
const { versionRouter } = require('../src/routes/version') as typeof import('../src/routes/version');

const SECRET = process.env.API_SECRET;

let passou = 0;
let falhou = 0;

function check(nome: string, real: unknown, esperado: unknown) {
  if (JSON.stringify(real) === JSON.stringify(esperado)) {
    passou++;
    console.log(`  ok   ${nome}`);
  } else {
    falhou++;
    console.log(`  FALHA ${nome}\n        esperado: ${JSON.stringify(esperado)}\n        real:     ${JSON.stringify(real)}`);
  }
}

const app = express();
app.use(express.json({ limit: '5mb' }));
app.use('/api/chat', chatRouter);
app.use('/api/stages', stagesRouter);
app.use('/api/typing', typingRouter);
app.use('/api/version', versionRouter);
app.get('/', (_req: unknown, res: { json: (b: unknown) => void }) => res.json({ service: 'fast-agent-api', status: 'ok' }));

const server = app.listen(0, async () => {
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  const base = `http://127.0.0.1:${port}`;
  console.log(`Servidor de teste em ${base}\n`);

  const req = async (caminho: string, init?: RequestInit) => {
    const r = await fetch(base + caminho, init);
    const texto = await r.text();
    let corpo: unknown = texto;
    try { corpo = JSON.parse(texto); } catch { /* mantém texto */ }
    return { status: r.status, corpo };
  };

  const json = (body: unknown, token?: string): RequestInit => ({
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });

  try {
    console.log('[1] Health');
    const raiz = await req('/');
    check('GET / responde 200', raiz.status, 200);
    check('GET / identifica o serviço', raiz.corpo, { service: 'fast-agent-api', status: 'ok' });

    const health = await req('/api/chat/health');
    check('GET /api/chat/health responde 200', health.status, 200);
    check('health traz status ok',
      (health.corpo as { status?: string }).status, 'ok');

    console.log('\n[2] Autenticação');
    const semToken = await req('/api/chat', json({}));
    check('POST sem Authorization → 401', semToken.status, 401);
    check('401 não vaza detalhe', semToken.corpo, { error: 'Unauthorized' });

    const tokenErrado = await req('/api/chat', json({}, 'token-errado'));
    check('POST com token errado → 401', tokenErrado.status, 401);

    console.log('\n[3] Validação de payload');
    const vazio = await req('/api/chat', json({}, SECRET));
    check('body vazio → 400', vazio.status, 400);
    check('400 explica o que faltou',
      typeof (vazio.corpo as { details?: unknown }).details === 'object', true);

    const faltando = await req('/api/chat', json({ agent_id: 'a' }, SECRET));
    check('body incompleto → 400', faltando.status, 400);

    const tipoErrado = await req('/api/chat', json({
      agent_id: 'a', conversation_id: 'b', lead_id: 'c', contact_phone: '55',
      scoped_client_id: 'a:55', client_messages: 'oi',
      system_prompt: 'teste', model_provider: 'provider-inexistente',
    }, SECRET));
    check('model_provider inválido → 400', tipoErrado.status, 400);

    console.log('\n[4] Resiliência — provider e banco fora do ar');
    const completo = await req('/api/chat', json({
      agent_id: '00000000-0000-0000-0000-000000000000',
      conversation_id: '00000000-0000-0000-0000-000000000000',
      lead_id: '00000000-0000-0000-0000-000000000000',
      contact_phone: '5500000000000',
      scoped_client_id: 'smoke:5500000000000',
      client_messages: 'oi',
      system_prompt: 'Você é um agente de teste.',
      model_provider: 'openai',
      model_name: 'gpt-4.1-mini',
    }, SECRET));

    check('OpenAI recusando não vira 5xx', completo.status, 200);
    const corpo = completo.corpo as { mensagens?: string[]; redirect_human?: boolean };
    check('resposta traz mensagens não vazias',
      Array.isArray(corpo.mensagens) && corpo.mensagens.length > 0 && corpo.mensagens.every((m) => m.trim() !== ''), true);
    check('nenhuma mensagem vaza JSON estrutural',
      corpo.mensagens?.some((m) => /"(mensagens|redirect_human|transfer_reason)"\s*:/.test(m)) ?? false, false);
    check('nenhuma mensagem vaza stack trace',
      corpo.mensagens?.some((m) => /\bat\s+\w+\s*\(|Error:|node_modules/.test(m)) ?? false, false);
    check('nenhuma mensagem vaza credencial',
      corpo.mensagens?.some((m) => /sk-|eyJ|service-falsa|smoke-secret/.test(m)) ?? false, false);

    console.log('\n[5] Rotas vizinhas continuam protegidas');
    const stages = await req('/api/stages', json({}, undefined));
    check('POST /api/stages sem token não devolve 2xx', stages.status < 200 || stages.status >= 300, true);
    const typing = await req('/api/typing', json({}, undefined));
    check('POST /api/typing sem token não devolve 2xx', typing.status < 200 || typing.status >= 300, true);

    const inexistente = await req('/rota/que/nao/existe');
    check('rota inexistente → 404', inexistente.status, 404);

    console.log('\n[6] /api/version diz qual commit está no ar');
    const versao = await req('/api/version');
    const vCorpo = versao.corpo as Record<string, unknown>;
    check('GET /api/version → 200', versao.status, 200);
    check('responde sem exigir token', typeof vCorpo?.commit === 'string', true);
    check('identifica o serviço', vCorpo?.service, 'fast-agent-api');
    // Sem a variável do Railway o valor é "desconhecido" — nunca undefined, senão
    // quem confere o deploy não distingue "não sei" de "campo quebrado".
    check('commit tem valor mesmo fora do Railway', vCorpo?.commit, 'desconhecido');
    check('não vaza credencial', /sk-|eyJ|service-falsa|smoke-secret/.test(JSON.stringify(vCorpo)), false);
  } catch (err) {
    falhou++;
    console.log(`  FALHA exceção no smoke: ${err instanceof Error ? err.message : String(err)}`);
  }

  console.log(`\n${'─'.repeat(52)}`);
  console.log(`${passou} passaram, ${falhou} falharam`);
  server.close();
  process.exit(falhou === 0 ? 0 : 1);
});
