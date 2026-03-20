import axios from 'axios';

// ── Adapter Interface ──────────────────────────────────────────

export interface SendMessageParams {
  phone: string;
  content: string;
  type?: string;
  mediaUrl?: string;
}

export interface AdapterResult {
  success: boolean;
  providerMessageId?: string;
  error?: string;
}

// ── WhatsBizAPI Adapter ────────────────────────────────────────

/**
 * Send text message via WhatsBizAPI
 */
async function whatsbizapiSendText(
  baseUrl: string,
  token: string,
  phone: string,
  message: string,
): Promise<AdapterResult> {
  try {
    const endpoint = `${baseUrl}/api/wpbox/sendmessage`;
    const body = {
      token,
      phone,
      message,
    };

    console.log(`[WhatsBizAPI] Sending text to ${phone}`);

    const res = await axios.post(endpoint, body, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 30_000,
    });

    const data = res.data as Record<string, unknown>;

    if (data.error) {
      return { success: false, error: String(data.error) };
    }

    const messageId = String(data.message_id ?? data.message_wamid ?? '');
    console.log(`[WhatsBizAPI] ✅ Text sent successfully. ID: ${messageId}`);

    return {
      success: true,
      providerMessageId: messageId,
    };
  } catch (e: unknown) {
    if (axios.isAxiosError(e)) {
      const errMsg = (e.response?.data as Record<string, unknown>)?.error ?? e.message;
      console.error(`[WhatsBizAPI] ❌ Text send failed: ${errMsg}`);
      return { success: false, error: String(errMsg) };
    }
    console.error(`[WhatsBizAPI] ❌ Text send failed: ${String(e)}`);
    return { success: false, error: String(e) };
  }
}

/**
 * Send media message via WhatsBizAPI (image, video, audio, document)
 */
async function whatsbizapiSendMedia(
  baseUrl: string,
  token: string,
  phone: string,
  type: string,
  url: string,
  caption?: string,
): Promise<AdapterResult> {
  try {
    const endpoint = `${baseUrl}/api/wpbox/sendmedia`;
    const body: Record<string, unknown> = {
      token,
      phone,
      type,
      url,
    };

    // Add caption/message if provided
    if (caption) {
      body.message = caption;
    }

    console.log(`[WhatsBizAPI] Sending ${type} to ${phone}`);

    const res = await axios.post(endpoint, body, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 30_000,
    });

    const data = res.data as Record<string, unknown>;

    if (data.error) {
      return { success: false, error: String(data.error) };
    }

    const messageId = String(data.message_id ?? data.message_wamid ?? '');
    console.log(`[WhatsBizAPI] ✅ ${type} sent successfully. ID: ${messageId}`);

    return {
      success: true,
      providerMessageId: messageId,
    };
  } catch (e: unknown) {
    if (axios.isAxiosError(e)) {
      const errMsg = (e.response?.data as Record<string, unknown>)?.error ?? e.message;
      console.error(`[WhatsBizAPI] ❌ ${type} send failed: ${errMsg}`);
      return { success: false, error: String(errMsg) };
    }
    console.error(`[WhatsBizAPI] ❌ ${type} send failed: ${String(e)}`);
    return { success: false, error: String(e) };
  }
}

/**
 * Main WhatsBizAPI adapter - routes to appropriate sender based on type
 */
export async function whatsbizapiSend(
  credentials: Record<string, string>,
  params: SendMessageParams,
): Promise<AdapterResult> {
  const baseUrl = credentials.api_url || 'https://app.whatsbizapi.com';
  const token = credentials.api_token;

  // Validate credentials
  if (!token) {
    return { success: false, error: 'Missing WhatsBizAPI token' };
  }

  // Validate phone number
  if (!params.phone) {
    return { success: false, error: 'Missing phone number' };
  }

  const messageType = params.type || 'text';

  // ── TEXT MESSAGE ──────────────────────────────────────────────
  if (messageType === 'text') {
    if (!params.content) {
      return { success: false, error: 'Missing message content for text type' };
    }
    return whatsbizapiSendText(baseUrl, token, params.phone, params.content);
  }

  // ── MEDIA MESSAGES ────────────────────────────────────────────
  if (!params.mediaUrl) {
    return { success: false, error: `Missing media URL for ${messageType} type` };
  }

  // Map internal types to WhatsBizAPI types
  let apiType: string;
  switch (messageType) {
    case 'image':
      apiType = 'image';
      break;
    case 'video':
      apiType = 'video';
      break;
    case 'audio':
    case 'ptt':
      apiType = 'audio';
      break;
    case 'document':
      apiType = 'document';
      break;
    default:
      return { success: false, error: `Unsupported message type: ${messageType}` };
  }

  return whatsbizapiSendMedia(
    baseUrl,
    token,
    params.phone,
    apiType,
    params.mediaUrl,
    params.content,
  );
}

// ── Z-API Adapter ──────────────────────────────────────────────

export async function zapiSend(
  credentials: Record<string, string>,
  params: SendMessageParams,
  zapiClientToken: string,
): Promise<AdapterResult> {
  const instanceId = credentials.instance_id;
  const token      = credentials.api_token;
  const baseUrl    = credentials.api_url || 'https://api.z-api.io';

  if (!instanceId || !token) {
    return { success: false, error: 'Missing Z-API credentials (instance_id or api_token)' };
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Client-Token': zapiClientToken,
  };

  try {
    let endpoint: string;
    let body: Record<string, unknown>;

    const base = `${baseUrl}/instances/${instanceId}/token/${token}`;

    if (params.type && params.type !== 'text') {
      switch (params.type) {
        case 'video':
          endpoint = `${base}/send-video`;
          body = { phone: params.phone, video: params.mediaUrl, caption: params.content || '' };
          break;
        case 'audio':
        case 'ptt':
          endpoint = `${base}/send-audio`;
          body = { phone: params.phone, audio: params.mediaUrl };
          break;
        case 'document':
          endpoint = `${base}/send-document/${encodeURIComponent(params.content || 'arquivo')}`;
          body = { phone: params.phone, document: params.mediaUrl };
          break;
        default:
          // image and any other media type
          endpoint = `${base}/send-image`;
          body = { phone: params.phone, image: params.mediaUrl, caption: params.content || '' };
          break;
      }
    } else {
      endpoint = `${base}/send-text`;
      body = { phone: params.phone, message: params.content };
    }

    const res = await axios.post(endpoint, body, { headers, timeout: 30_000 });
    const data = res.data as Record<string, unknown>;

    return {
      success: true,
      providerMessageId: String(data.messageId ?? data.id ?? ''),
    };
  } catch (e: unknown) {
    if (axios.isAxiosError(e)) {
      const msg = (e.response?.data as Record<string, unknown>)?.error ?? e.message;
      return { success: false, error: String(msg) };
    }
    return { success: false, error: String(e) };
  }
}

// ── Adapter selector ───────────────────────────────────────────

export type AdapterFn = (
  credentials: Record<string, string>,
  params: SendMessageParams,
  zapiClientToken: string,
) => Promise<AdapterResult>;

export function getAdapter(provider: string): AdapterFn {
  if (provider === 'whatsbizapi') {
    return (creds, params) => whatsbizapiSend(creds, params);
  }
  if (provider === 'zapi') {
    return zapiSend;
  }
  throw new Error(`Unknown provider: ${provider}`);
}
