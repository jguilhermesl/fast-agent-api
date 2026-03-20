#!/usr/bin/env ts-node

import OpenAI from 'openai';
import { supabase } from '../src/services/supabase';
import { config } from '../src/config';

// ============================================================
// Script de teste para searchKnowledgeBase
// ============================================================
// Uso: npx ts-node scripts/test-knowledge-base.ts <agent_id> "<query>"
// Exemplo: npx ts-node scripts/test-knowledge-base.ts "123e4567-e89b-12d3-a456-426614174000" "Como funciona o agendamento?"

const openai = new OpenAI({ apiKey: config.openaiApiKey });

// Configurações da busca (mesmas do serviço)
const KB_MATCH_COUNT = 5;
const KB_MIN_SIMILARITY = 1.30; // Alinhado com o serviço - similarity > 1 indica distância vetorial

interface DocumentMatch {
  content: string;
  similarity: number;
  metadata?: Record<string, unknown>;
}

interface TestResult {
  agentId: string;
  query: string;
  embeddingModel: string;
  embeddingTokens: number;
  embeddingCostUsd: number;
  totalTimeMs: number;
  results: string;
  success: boolean;
  error?: string;
}

async function testKnowledgeBase(agentId: string, query: string): Promise<TestResult> {
  const startTime = Date.now();
  
  console.log('\n' + '='.repeat(70));
  console.log('🔍 TESTE DE BUSCA NA BASE DE CONHECIMENTO');
  console.log('='.repeat(70));
  console.log(`\n📋 Agent ID: ${agentId}`);
  console.log(`💬 Query: "${query}"\n`);

  try {
    // ── Passo 1: Gerar embedding ──────────────────────────────
    console.log('⏳ Gerando embedding da query...');
    const embeddingStartTime = Date.now();
    
    const embeddingResponse = await openai.embeddings.create({
      model: 'text-embedding-3-small',
      input: query,
    });
    
    const embeddingTime = Date.now() - embeddingStartTime;
    const embedding = embeddingResponse.data[0].embedding;
    const embeddingTokens = embeddingResponse.usage?.total_tokens ?? 0;
    
    console.log(`✅ Embedding gerado em ${embeddingTime}ms`);
    console.log(`   Dimensões: ${embedding.length}`);
    console.log(`   Tokens usados: ${embeddingTokens}`);

    // ── Passo 2: Calcular custo do embedding ─────────────────
    // Custo do text-embedding-3-small: $0.020 per 1M tokens (março 2026)
    const embeddingCostUsd = embeddingTokens * 0.00000002;
    console.log(`   Custo: $${embeddingCostUsd.toFixed(8)} USD\n`);

    // ── Passo 3: Buscar na base de conhecimento ───────────────
    console.log('⏳ Buscando na base de conhecimento...');
    const searchStartTime = Date.now();
    
    const { data, error } = await supabase.rpc('match_documents', {
      query_embedding: embedding,
      filter: { agent_id: agentId },
      match_count: KB_MATCH_COUNT,
    });

    const searchTime = Date.now() - searchStartTime;
    console.log(`✅ Busca concluída em ${searchTime}ms\n`);

    if (error) {
      throw new Error(`Erro na busca: ${error.message}`);
    }

    const docs = (data ?? []) as DocumentMatch[];
    const relevant = docs.filter((d) => d.similarity >= KB_MIN_SIMILARITY);

    // ── Passo 4: Exibir resultados detalhados ─────────────────
    const totalTime = Date.now() - startTime;
    
    console.log('='.repeat(70));
    console.log(`📊 DOCUMENTOS ENCONTRADOS (${docs.length} resultados)`);
    console.log('='.repeat(70));
    
    if (docs.length === 0) {
      console.log('\n❌ Nenhum documento encontrado na base de conhecimento.\n');
    } else {
      console.log(`\n✅ Total retornado: ${docs.length}`);
      console.log(`✅ Acima do threshold (>= ${KB_MIN_SIMILARITY}): ${relevant.length}`);
      
      if (relevant.length > 0) {
        const minScore = Math.min(...relevant.map(d => d.similarity));
        const maxScore = Math.max(...relevant.map(d => d.similarity));
        console.log(`📊 Range de similarity: ${minScore.toFixed(4)} - ${maxScore.toFixed(4)}\n`);
      } else {
        console.log(`⚠️  Nenhum documento passou no threshold de ${KB_MIN_SIMILARITY}\n`);
      }

      // Exibe cada documento individualmente
      docs.forEach((doc, index) => {
        const passedFilter = doc.similarity >= KB_MIN_SIMILARITY;
        const statusIcon = passedFilter ? '✅' : '❌';
        const statusText = passedFilter ? 'APROVADO' : 'REJEITADO (baixa similaridade)';
        
        console.log('━'.repeat(70));
        console.log(`📄 DOCUMENTO #${index + 1} ${statusIcon} ${statusText}`);
        console.log('━'.repeat(70));
        console.log(`🎯 Similarity Score: ${doc.similarity.toFixed(4)}`);
        
        if (doc.metadata && Object.keys(doc.metadata).length > 0) {
          console.log(`📋 Metadata: ${JSON.stringify(doc.metadata, null, 2)}`);
        } else {
          console.log(`📋 Metadata: (nenhuma)`);
        }
        
        console.log(`📝 Conteúdo (${doc.content.length} caracteres):`);
        console.log('─'.repeat(70));
        console.log(doc.content);
        console.log('─'.repeat(70));
        console.log('');
      });
    }

    console.log('='.repeat(70));

    // ── Passo 5: Resumo de gastos ────────────────────────────
    console.log('💰 RESUMO DE GASTOS');
    console.log('='.repeat(70));
    console.log(`📌 Modelo de embedding: text-embedding-3-small`);
    console.log(`📌 Tokens consumidos: ${embeddingTokens}`);
    console.log(`📌 Custo total: $${embeddingCostUsd.toFixed(8)} USD`);
    console.log(`📌 Custo em BRL (aprox.): R$ ${(embeddingCostUsd * 5.5).toFixed(6)}`);
    console.log('='.repeat(70));

    // ── Passo 6: Métricas de performance ─────────────────────
    console.log('⚡ MÉTRICAS DE PERFORMANCE');
    console.log('='.repeat(70));
    console.log(`📌 Tempo de embedding: ${embeddingTime}ms`);
    console.log(`📌 Tempo de busca: ${searchTime}ms`);
    console.log(`📌 Tempo total: ${totalTime}ms`);
    console.log('='.repeat(70) + '\n');

    // Monta resultado textual para compatibilidade
    const resultsText = relevant.length > 0
      ? relevant.map(d => d.content).join('\n\n---\n\n')
      : '(nenhuma informação relevante encontrada na base de conhecimento)';

    return {
      agentId,
      query,
      embeddingModel: 'text-embedding-3-small',
      embeddingTokens,
      embeddingCostUsd,
      totalTimeMs: totalTime,
      results: resultsText,
      success: true,
    };

  } catch (error) {
    const totalTime = Date.now() - startTime;
    const errorMessage = error instanceof Error ? error.message : String(error);
    
    console.error('\n' + '='.repeat(70));
    console.error('❌ ERRO DURANTE A BUSCA');
    console.error('='.repeat(70));
    console.error(`Mensagem: ${errorMessage}`);
    console.error('='.repeat(70) + '\n');

    return {
      agentId,
      query,
      embeddingModel: 'text-embedding-3-small',
      embeddingTokens: 0,
      embeddingCostUsd: 0,
      totalTimeMs: totalTime,
      results: '',
      success: false,
      error: errorMessage,
    };
  }
}

// ── Execução principal ──────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);

  if (args.length < 2) {
    console.error('\n❌ Uso incorreto!\n');
    console.log('📖 Como usar:');
    console.log('   npx ts-node scripts/test-knowledge-base.ts <agent_id> "<query>"\n');
    console.log('📝 Exemplo:');
    console.log('   npx ts-node scripts/test-knowledge-base.ts "123e4567-e89b-12d3-a456-426614174000" "Como funciona o agendamento?"\n');
    process.exit(1);
  }

  const [agentId, query] = args;
  
  await testKnowledgeBase(agentId, query);
}

main().catch((error) => {
  console.error('❌ Erro fatal:', error);
  process.exit(1);
});
