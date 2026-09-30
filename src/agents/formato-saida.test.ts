import { describe, it, expect } from 'vitest';
import { sufixoDeSaida, normalizarEstilo } from './formato-saida';

// Cópia literal do OUTPUT_SCHEMA_SUFFIX de orchestrator.ts em 8e30dfd (antes de
// 30/09/2026). Quem não está no estilo `conciso` tem que continuar recebendo
// exatamente isto: 11 dos 12 agentes ativos não têm suíte.
const SUFIXO_ANTIGO = `

---

# FORMATO DE RESPOSTA — OBRIGATÓRIO
Responda SOMENTE com JSON válido no formato abaixo. Nenhum texto fora do JSON.

\`\`\`json
{
  "mensagens": ["mensagem 1", "mensagem 2"],
  "redirect_human": false,
  "transfer_reason": null
}
\`\`\`

- **mensagens**: array de strings. Quebre em múltiplas mensagens curtas quando fizer sentido para WhatsApp. Nunca retorne um array vazio.
- **redirect_human**: \`true\` apenas se precisar transferir para humano, caso contrário \`false\`.
- **transfer_reason**: quando \`redirect_human\` for \`true\`, preencha com o motivo da transferência em uma frase curta (ex: "Cliente solicitou atendimento humano", "Dúvida sobre contrato fora do escopo"). Quando \`false\`, use \`null\`.
- **Proibido**: nunca termine mensagens com frases genéricas de encerramento como "Se precisar de mais alguma coisa, é só avisar!", "Fico à disposição!", "Qualquer dúvida estou aqui!" ou similares. Encerre de forma natural e direta, sem filler.`;

describe('sufixoDeSaida: estilo conciso não manda dividir', () => {
  const s = sufixoDeSaida('conciso');

  it('não tem mais "Quebre em múltiplas mensagens"', () => {
    expect(s).not.toMatch(/Quebre em m[úu]ltiplas mensagens/i);
  });

  it('pede UMA mensagem curta e só divide com necessidade real', () => {
    expect(s).toMatch(/prefira UMA mensagem curta/);
    expect(s).toMatch(/necessidade real/);
    expect(s).toMatch(/Nunca uma mensagem por frase/);
  });

  it('não inventa teto numérico de mensagens (a persona é dona disso)', () => {
    expect(s).not.toMatch(/(no m[áa]ximo|nunca mais de) (duas|2|tr[êe]s|3) mensagens/i);
  });

  it('mantém o contrato JSON inteiro', () => {
    expect(s).toContain('"mensagens": ["mensagem 1", "mensagem 2"]');
    expect(s).toContain('**redirect_human**');
    expect(s).toContain('**transfer_reason**');
    expect(s).toContain('Nunca retorne um array vazio.');
    expect(s).toContain('**Proibido**');
  });

  it('só a linha de mensagens muda em relação ao sufixo antigo', () => {
    const antigas = SUFIXO_ANTIGO.split('\n');
    const novas = s.split('\n');
    expect(novas.length).toBe(antigas.length);
    const diferentes = antigas.map((l, i) => (l === novas[i] ? null : i)).filter((i) => i !== null);
    expect(diferentes).toHaveLength(1);
    expect(antigas[diferentes[0] as number]).toMatch(/^- \*\*mensagens\*\*/);
  });

  it('aceita caixa e espaço do banco ("Conciso ")', () => {
    expect(sufixoDeSaida(' Conciso ')).toBe(s);
  });
});

describe('sufixoDeSaida: fora do conciso, texto de antes byte a byte', () => {
  for (const estilo of ['equilibrado', 'detalhado', undefined, null, '', '   ', 'qualquer-coisa', 42, {}]) {
    it(`${JSON.stringify(estilo) ?? 'undefined'} → sufixo antigo`, () => {
      expect(sufixoDeSaida(estilo)).toBe(SUFIXO_ANTIGO);
    });
  }
});

describe('normalizarEstilo', () => {
  it('ausente cai em equilibrado, como no n8n (`|| \'equilibrado\'`)', () => {
    expect(normalizarEstilo(undefined)).toBe('equilibrado');
    expect(normalizarEstilo(null)).toBe('equilibrado');
    expect(normalizarEstilo('')).toBe('equilibrado');
  });
  it('minúsculo e sem espaço', () => {
    expect(normalizarEstilo(' CONCISO')).toBe('conciso');
  });
});
