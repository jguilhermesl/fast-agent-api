/**
 * Test script for WhatsBizAPI adapter
 * 
 * Usage:
 * npm run test:whatsbizapi
 * 
 * Required env vars:
 * - WHATSBIZAPI_TOKEN
 * - TEST_PHONE_NUMBER
 */

import 'dotenv/config';
import { whatsbizapiSend } from '../src/adapters/messaging';

const token = process.env.WHATSBIZAPI_TOKEN;
const testPhone = process.env.TEST_PHONE_NUMBER;

if (!token || !testPhone) {
  console.error('❌ Missing required env vars: WHATSBIZAPI_TOKEN and TEST_PHONE_NUMBER');
  process.exit(1);
}

const credentials = {
  api_token: token,
  api_url: process.env.WHATSBIZAPI_URL || 'https://whatsbizapi.com/api/wpbox',
};

// ── Test Functions ─────────────────────────────────────────────

async function testTextMessage() {
  console.log('\n📝 Testing TEXT message...');
  const result = await whatsbizapiSend(credentials, {
    phone: testPhone as string,
    content: 'Olá! Esta é uma mensagem de teste do Fast Agent API 🚀',
    type: 'text',
  });

  if (result.success) {
    console.log('✅ Text message sent successfully');
    console.log(`   Message ID: ${result.providerMessageId}`);
  } else {
    console.error('❌ Text message failed:', result.error);
  }
  return result;
}

async function testImageMessage() {
  console.log('\n🖼️  Testing IMAGE message...');
  const result = await whatsbizapiSend(credentials, {
    phone: testPhone as string,
    content: 'Aqui está uma imagem de teste',
    type: 'image',
    mediaUrl: 'https://picsum.photos/800/600',
  });

  if (result.success) {
    console.log('✅ Image message sent successfully');
    console.log(`   Message ID: ${result.providerMessageId}`);
  } else {
    console.error('❌ Image message failed:', result.error);
  }
  return result;
}

async function testVideoMessage() {
  console.log('\n🎥 Testing VIDEO message...');
  const result = await whatsbizapiSend(credentials, {
    phone: testPhone as string,
    content: 'Vídeo de teste',
    type: 'video',
    mediaUrl: 'https://sample-videos.com/video321/mp4/720/big_buck_bunny_720p_1mb.mp4',
  });

  if (result.success) {
    console.log('✅ Video message sent successfully');
    console.log(`   Message ID: ${result.providerMessageId}`);
  } else {
    console.error('❌ Video message failed:', result.error);
  }
  return result;
}

async function testAudioMessage() {
  console.log('\n🎵 Testing AUDIO message...');
  const result = await whatsbizapiSend(credentials, {
    phone: testPhone as string,
    content: '',
    type: 'audio',
    mediaUrl: 'https://www2.cs.uic.edu/~i101/SoundFiles/BabyElephantWalk60.wav',
  });

  if (result.success) {
    console.log('✅ Audio message sent successfully');
    console.log(`   Message ID: ${result.providerMessageId}`);
  } else {
    console.error('❌ Audio message failed:', result.error);
  }
  return result;
}

async function testPTTMessage() {
  console.log('\n🎙️  Testing PTT (voice) message...');
  const result = await whatsbizapiSend(credentials, {
    phone: testPhone as string,
    content: '',
    type: 'ptt',
    mediaUrl: 'https://www2.cs.uic.edu/~i101/SoundFiles/BabyElephantWalk60.wav',
  });

  if (result.success) {
    console.log('✅ PTT message sent successfully');
    console.log(`   Message ID: ${result.providerMessageId}`);
  } else {
    console.error('❌ PTT message failed:', result.error);
  }
  return result;
}

async function testDocumentMessage() {
  console.log('\n📄 Testing DOCUMENT message...');
  const result = await whatsbizapiSend(credentials, {
    phone: testPhone as string,
    content: 'Documento de teste',
    type: 'document',
    mediaUrl: 'https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf',
  });

  if (result.success) {
    console.log('✅ Document message sent successfully');
    console.log(`   Message ID: ${result.providerMessageId}`);
  } else {
    console.error('❌ Document message failed:', result.error);
  }
  return result;
}

// ── Main Test Runner ───────────────────────────────────────────

async function runTests() {
  console.log('╔════════════════════════════════════════════════════════╗');
  console.log('║       WhatsBizAPI Adapter Test Suite                  ║');
  console.log('╚════════════════════════════════════════════════════════╝');
  console.log(`\n📱 Test phone: ${testPhone}`);
  console.log(`🔑 API URL: ${credentials.api_url}`);

  const results = {
    text: false,
    image: false,
    video: false,
    audio: false,
    ptt: false,
    document: false,
  };

  // Run tests with delay between each
  results.text = (await testTextMessage()).success;
  await delay(2000);

  results.image = (await testImageMessage()).success;
  await delay(2000);

  results.video = (await testVideoMessage()).success;
  await delay(2000);

  results.audio = (await testAudioMessage()).success;
  await delay(2000);

  results.ptt = (await testPTTMessage()).success;
  await delay(2000);

  results.document = (await testDocumentMessage()).success;

  // Summary
  console.log('\n' + '═'.repeat(60));
  console.log('📊 TEST SUMMARY');
  console.log('═'.repeat(60));
  
  const passed = Object.values(results).filter(Boolean).length;
  const total = Object.keys(results).length;

  Object.entries(results).forEach(([type, success]) => {
    const icon = success ? '✅' : '❌';
    console.log(`${icon} ${type.toUpperCase().padEnd(12)} - ${success ? 'PASSED' : 'FAILED'}`);
  });

  console.log('═'.repeat(60));
  console.log(`\n${passed}/${total} tests passed`);
  
  if (passed === total) {
    console.log('🎉 All tests passed!\n');
    process.exit(0);
  } else {
    console.log('⚠️  Some tests failed\n');
    process.exit(1);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Run
runTests().catch((error) => {
  console.error('💥 Test suite error:', error);
  process.exit(1);
});
