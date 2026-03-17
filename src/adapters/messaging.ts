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

export async function whatsbizapiSend(
  credentials: Record<string, string>,
  params: SendMessageParams,
): Promise<AdapterResult> {
  const baseUrl = credentials.api_url || 'https://app.whatsbizapi.com';
  const token = credentials.api_token;

  if (!token) return { success: false, error: 'Missing WhatsBizAPI token' };

  try {
    const isMedia = params.type && params.type !== 'text';
    const endpoint = isMedia
      ? `${baseUrl}/api/wpbox/sendmedia`
      : `${baseUrl}/api/wpbox/sendmessage`;

    const body: Record<string, unknown> = {
      token,
      phone: params.phone,
    };

    if (isMedia) {
      body.type    = params.type;
      body.url     = params.mediaUrl;
      body.caption = params.content;
    } else {
      body.text = params.content;
    }

    const res = await axios.post(endpoint, body, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 30_000,
    });

    const data = res.data as Record<string, unknown>;

    if (data.error) {
      return { success: false, error: String(data.error) };
    }

    return {
      success: true,
      providerMessageId: String(data.message_id ?? data.wamid ?? ''),
    };
  } catch (e: unknown) {
    if (axios.isAxiosError(e)) {
      const msg = (e.response?.data as Record<string, unknown>)?.error ?? e.message;
      return { success: false, error: String(msg) };
    }
    return { success: false, error: String(e) };
  }
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
