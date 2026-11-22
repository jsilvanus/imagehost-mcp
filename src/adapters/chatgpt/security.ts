import { promises as dns } from 'node:dns';
import net from 'node:net';

export function isAllowedDomain(hostname: string, allowedDomains: string[]): boolean {
  const host = hostname.toLowerCase();
  return allowedDomains.some((domain) => {
    const cleanDomain = domain.trim().toLowerCase();
    return host === cleanDomain || host.endsWith(`.${cleanDomain}`);
  });
}

export function isPrivateOrReservedIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const parts = ip.split('.').map((p) => parseInt(p, 10));
    if (parts.length !== 4 || parts.some((p) => isNaN(p) || p < 0 || p > 255)) {
      return true;
    }
    // 0.0.0.0/8 (current network)
    if (parts[0] === 0) return true;
    // 127.0.0.0/8 (loopback)
    if (parts[0] === 127) return true;
    // 10.0.0.0/8 (private)
    if (parts[0] === 10) return true;
    // 172.16.0.0/12 (private)
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
    // 192.168.0.0/16 (private)
    if (parts[0] === 192 && parts[1] === 168) return true;
    // 169.254.0.0/16 (link-local)
    if (parts[0] === 169 && parts[1] === 254) return true;
    // 100.64.0.0/10 (carrier-grade NAT)
    if (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) return true;
    // 224.0.0.0/4 (multicast) & 240.0.0.0/4 (reserved)
    if (parts[0] >= 224) return true;
    return false;
  }

  if (net.isIPv6(ip)) {
    const lower = ip.toLowerCase();
    // Loopback ::1 or unspecified ::
    if (lower === '::1' || lower === '::') return true;
    // Link-local fe80::/10
    if (lower.startsWith('fe8') || lower.startsWith('fe9') || lower.startsWith('fea') || lower.startsWith('feb')) {
      return true;
    }
    // Unique local fc00::/7 (fc00... or fd00...)
    if (lower.startsWith('fc') || lower.startsWith('fd')) return true;
    // IPv4-mapped IPv6 ::ffff:x.x.x.x
    if (lower.startsWith('::ffff:')) {
      const v4Part = lower.slice(7);
      return isPrivateOrReservedIp(v4Part);
    }
    return false;
  }

  return true;
}

export function detectImageMimeType(buffer: Buffer): string | null {
  if (buffer.length < 12) return null;

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return 'image/png';
  }

  // JPEG: FF D8 FF
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg';
  }

  // WebP: 'RIFF' .... 'WEBP'
  if (
    buffer.toString('ascii', 0, 4) === 'RIFF' &&
    buffer.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return 'image/webp';
  }

  // GIF: 'GIF87a' or 'GIF89a'
  if (buffer.toString('ascii', 0, 4) === 'GIF8') {
    return 'image/gif';
  }

  return null;
}

export async function validateDownloadUrl(
  urlString: string,
  allowedDomains: string[],
  options?: { skipDnsLookup?: boolean },
): Promise<URL> {
  let parsed: URL;
  try {
    parsed = new URL(urlString);
  } catch {
    throw new Error('Invalid download URL format');
  }

  if (parsed.protocol !== 'https:') {
    throw new Error(`Insecure download URL protocol: expected https:, got ${parsed.protocol}`);
  }

  if (net.isIP(parsed.hostname)) {
    throw new Error('Direct IP addresses are not permitted as download hosts');
  }

  if (!isAllowedDomain(parsed.hostname, allowedDomains)) {
    throw new Error(`Untrusted download domain: host ${parsed.hostname} is not in the allowed domains list`);
  }

  if (!options?.skipDnsLookup) {
    try {
      const addresses = await dns.lookup(parsed.hostname, { all: true });
      for (const addr of addresses) {
        if (isPrivateOrReservedIp(addr.address)) {
          throw new Error(`SSRF blocked: host ${parsed.hostname} resolves to private or reserved IP ${addr.address}`);
        }
      }
    } catch (err: any) {
      if (err.message.startsWith('SSRF blocked')) throw err;
      throw new Error(`DNS resolution failed for download host ${parsed.hostname}: ${err.message}`);
    }
  }

  return parsed;
}

export async function safeDownloadImage(
  url: string,
  options: {
    allowedDomains: string[];
    maxBytes: number;
    timeoutMs: number;
    fetchImpl?: typeof fetch;
    skipDnsLookup?: boolean;
  },
): Promise<{ buffer: Buffer; detectedMime: string }> {
  await validateDownloadUrl(url, options.allowedDomains, { skipDnsLookup: options.skipDnsLookup });

  const fetchFunc = options.fetchImpl ?? globalThis.fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);

  try {
    const res = await fetchFunc(url, {
      method: 'GET',
      redirect: 'error', // Do not follow redirects to prevent redirect-based SSRF
      signal: controller.signal,
    });

    if (!res.ok) {
      throw new Error(`Download failed with HTTP ${res.status}: ${res.statusText}`);
    }

    const contentLength = res.headers.get('content-length');
    if (contentLength && parseInt(contentLength, 10) > options.maxBytes) {
      throw new Error(`Image size (${contentLength} bytes) exceeds maximum allowed size of ${options.maxBytes} bytes`);
    }

    if (!res.body) {
      throw new Error('Response body is empty');
    }

    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let receivedBytes = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        receivedBytes += value.length;
        if (receivedBytes > options.maxBytes) {
          try {
            await reader.cancel();
          } catch {
            // ignore cancel error
          }
          throw new Error(`Image size exceeds maximum allowed size of ${options.maxBytes} bytes`);
        }
        chunks.push(value);
      }
    }

    const buffer = Buffer.concat(chunks);
    const detectedMime = detectImageMimeType(buffer);
    if (!detectedMime) {
      throw new Error('Invalid image file signature: file does not match any supported image format (JPEG, PNG, WebP, GIF)');
    }

    return { buffer, detectedMime };
  } catch (err: any) {
    if (err.name === 'AbortError') {
      throw new Error(`Download timed out after ${options.timeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
