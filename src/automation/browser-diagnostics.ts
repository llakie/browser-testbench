import { TestbenchDefaults } from '../config/defaults.js';
import type { BrowserHandle } from './browser-session.js';

export interface DiagnosticEvent {
    type: 'console' | 'request' | 'response' | 'requestFailed' | 'webSocket' | 'webSocketFrame';
    timestamp: string;
    level?: string;
    message?: string;
    requestId?: string;
    method?: string;
    url?: string;
    status?: number;
    statusText?: string;
    mimeType?: string;
    headers?: Record<string, unknown>;
    body?: string;
    error?: string;
    durationMs?: number;
    phase?: 'created' | 'handshakeRequest' | 'handshakeResponse' | 'closed' | 'error';
    direction?: 'sent' | 'received';
    opcode?: number;
}

export class BrowserDiagnostics {
    private readonly diagnosticEvents: DiagnosticEvent[] = [];
    private readonly requestTimestamps = new Map<string, number>();
    private readonly webSocketUrls = new Map<string, string>();

    async read(browser: BrowserHandle): Promise<DiagnosticEvent[]> {
        await this.collect(browser);
        return [...this.diagnosticEvents];
    }

    clear(): void {
        this.diagnosticEvents.length = 0;
        this.requestTimestamps.clear();
        this.webSocketUrls.clear();
    }

    private async collect(browser: BrowserHandle): Promise<void> {
        try {
            const entries = (await browser.logs('browser')) as Array<{
                level?: { name?: string };
                message?: string;
                timestamp?: number;
            }>;

            for (const entry of entries) {
                this.pushDiagnostic({
                    type: 'console',
                    timestamp: new Date(entry.timestamp ?? Date.now()).toISOString(),
                    level: entry.level?.name,
                    message: entry.message,
                });
            }
        } catch {
            // Browser logs are driver-dependent. Unsupported targets simply return no console events.
        }

        try {
            const entries = (await browser.logs('performance')) as Array<{
                message?: string;
                timestamp?: number;
            }>;

            for (const entry of entries) {
                const envelope = JSON.parse(entry.message ?? '{}') as {
                    message?: { method?: string; params?: Record<string, unknown> };
                };
                const message = envelope.message;

                if (message?.method === 'Network.requestWillBeSent') {
                    const request = message.params?.request as
                        | {
                              method?: string;
                              url?: string;
                              headers?: Record<string, unknown>;
                              postData?: string;
                          }
                        | undefined;
                    const requestId = message.params?.requestId as string | undefined;
                    const timestamp = message.params?.timestamp as number | undefined;

                    if (requestId && timestamp) {
                        this.requestTimestamps.set(requestId, timestamp);
                    }

                    this.pushDiagnostic({
                        type: 'request',
                        timestamp: new Date(entry.timestamp ?? Date.now()).toISOString(),
                        method: request?.method,
                        url: request?.url,
                        headers: request?.headers,
                        body: request?.postData?.slice(0, TestbenchDefaults.PAGE_SOURCE_LIMIT),
                    });
                }

                if (message?.method === 'Network.responseReceived') {
                    const response = message.params?.response as
                        | {
                              status?: number;
                              url?: string;
                              mimeType?: string;
                              headers?: Record<string, unknown>;
                          }
                        | undefined;
                    const requestId = message.params?.requestId as string | undefined;
                    const timestamp = message.params?.timestamp as number | undefined;
                    const startedAt = requestId ? this.requestTimestamps.get(requestId) : undefined;
                    const body = requestId
                        ? await this.responseBody(browser, requestId)
                        : undefined;
                    this.pushDiagnostic({
                        type: 'response',
                        timestamp: new Date(entry.timestamp ?? Date.now()).toISOString(),
                        status: response?.status,
                        url: response?.url,
                        mimeType: response?.mimeType,
                        headers: response?.headers,
                        body,
                        durationMs:
                            timestamp && startedAt
                                ? Math.round((timestamp - startedAt) * 1_000)
                                : undefined,
                    });

                    if (requestId) {
                        this.requestTimestamps.delete(requestId);
                    }
                }

                if (message?.method === 'Network.loadingFailed') {
                    const requestId = message.params?.requestId as string | undefined;
                    this.pushDiagnostic({
                        type: 'requestFailed',
                        timestamp: new Date(entry.timestamp ?? Date.now()).toISOString(),
                        error: message.params?.errorText as string | undefined,
                    });

                    if (requestId) {
                        this.requestTimestamps.delete(requestId);
                    }
                }

                if (message?.method === 'Network.webSocketCreated') {
                    const requestId = message.params?.requestId as string | undefined;
                    const url = message.params?.url as string | undefined;

                    if (requestId && url) {
                        this.webSocketUrls.set(requestId, url);
                    }

                    this.pushDiagnostic({
                        type: 'webSocket',
                        phase: 'created',
                        timestamp: new Date(entry.timestamp ?? Date.now()).toISOString(),
                        requestId,
                        url,
                    });
                }

                if (message?.method === 'Network.webSocketWillSendHandshakeRequest') {
                    const requestId = message.params?.requestId as string | undefined;
                    const request = message.params?.request as
                        { headers?: Record<string, unknown> } | undefined;
                    this.pushDiagnostic({
                        type: 'webSocket',
                        phase: 'handshakeRequest',
                        timestamp: new Date(entry.timestamp ?? Date.now()).toISOString(),
                        requestId,
                        url: requestId ? this.webSocketUrls.get(requestId) : undefined,
                        headers: request?.headers,
                    });
                }

                if (message?.method === 'Network.webSocketHandshakeResponseReceived') {
                    const requestId = message.params?.requestId as string | undefined;
                    const response = message.params?.response as
                        | {
                              status?: number;
                              statusText?: string;
                              headers?: Record<string, unknown>;
                          }
                        | undefined;
                    this.pushDiagnostic({
                        type: 'webSocket',
                        phase: 'handshakeResponse',
                        timestamp: new Date(entry.timestamp ?? Date.now()).toISOString(),
                        requestId,
                        url: requestId ? this.webSocketUrls.get(requestId) : undefined,
                        status: response?.status,
                        statusText: response?.statusText,
                        headers: response?.headers,
                    });
                }

                if (
                    message?.method === 'Network.webSocketFrameSent' ||
                    message?.method === 'Network.webSocketFrameReceived'
                ) {
                    const requestId = message.params?.requestId as string | undefined;
                    const frame = message.params?.response as
                        { opcode?: number; payloadData?: string } | undefined;
                    this.pushDiagnostic({
                        type: 'webSocketFrame',
                        timestamp: new Date(entry.timestamp ?? Date.now()).toISOString(),
                        requestId,
                        url: requestId ? this.webSocketUrls.get(requestId) : undefined,
                        direction:
                            message.method === 'Network.webSocketFrameSent' ? 'sent' : 'received',
                        opcode: frame?.opcode,
                        body: frame?.payloadData?.slice(0, TestbenchDefaults.PAGE_SOURCE_LIMIT),
                    });
                }

                if (message?.method === 'Network.webSocketFrameError') {
                    const requestId = message.params?.requestId as string | undefined;
                    this.pushDiagnostic({
                        type: 'webSocket',
                        phase: 'error',
                        timestamp: new Date(entry.timestamp ?? Date.now()).toISOString(),
                        requestId,
                        url: requestId ? this.webSocketUrls.get(requestId) : undefined,
                        error: message.params?.errorMessage as string | undefined,
                    });
                }

                if (message?.method === 'Network.webSocketClosed') {
                    const requestId = message.params?.requestId as string | undefined;
                    this.pushDiagnostic({
                        type: 'webSocket',
                        phase: 'closed',
                        timestamp: new Date(entry.timestamp ?? Date.now()).toISOString(),
                        requestId,
                        url: requestId ? this.webSocketUrls.get(requestId) : undefined,
                    });

                    if (requestId) {
                        this.webSocketUrls.delete(requestId);
                    }
                }
            }
        } catch {
            // Performance logging is currently available on Chromium targets only.
        }
    }

    private async responseBody(
        browser: BrowserHandle,
        requestId: string,
    ): Promise<string | undefined> {
        try {
            const result = (await browser.devtools('Network.getResponseBody', { requestId })) as {
                body?: string;
                base64Encoded?: boolean;
            };

            if (!result.body) {
                return undefined;
            }

            const body = result.base64Encoded
                ? Buffer.from(result.body, 'base64').toString('utf8')
                : result.body;
            return body.slice(0, TestbenchDefaults.PAGE_SOURCE_LIMIT);
        } catch {
            return undefined;
        }
    }

    private pushDiagnostic(event: DiagnosticEvent): void {
        this.diagnosticEvents.push({
            ...event,
            ...(event.headers ? { headers: this.redactHeaders(event.headers) } : {}),
        });

        if (this.diagnosticEvents.length > TestbenchDefaults.DIAGNOSTIC_EVENT_LIMIT) {
            this.diagnosticEvents.splice(
                0,
                this.diagnosticEvents.length - TestbenchDefaults.DIAGNOSTIC_EVENT_LIMIT,
            );
        }
    }

    private redactHeaders(headers: Record<string, unknown>): Record<string, unknown> {
        return Object.fromEntries(
            Object.entries(headers).map(([name, value]) => [
                name,
                /^(authorization|proxy-authorization|cookie|set-cookie)$/iu.test(name)
                    ? '[REDACTED]'
                    : value,
            ]),
        );
    }
}
