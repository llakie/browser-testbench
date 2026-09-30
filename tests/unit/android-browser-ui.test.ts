import { afterEach, describe, expect, it, vi } from 'vitest';
import { AndroidBrowserUi } from '../../src/automation/android-browser-ui.js';

describe('AndroidBrowserUi', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('dismisses native Chrome infobars and restores the web context', async () => {
        const requests: Array<{ path: string; method: string; body?: Record<string, unknown> }> =
            [];
        const values = [
            'WEBVIEW_chrome',
            null,
            [
                { 'element-6066-11e4-a52e-4f735466cecf': 'infobar-close' },
                { ELEMENT: 'negative-action' },
            ],
            null,
            null,
            null,
        ];
        vi.stubGlobal(
            'fetch',
            vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
                const url = new URL(String(input));
                requests.push({
                    path: url.pathname,
                    method: init?.method ?? 'GET',
                    ...(init?.body
                        ? { body: JSON.parse(String(init.body)) as Record<string, unknown> }
                        : {}),
                });
                return new Response(JSON.stringify({ value: values.shift() }), {
                    headers: { 'content-type': 'application/json' },
                });
            }),
        );

        await expect(AndroidBrowserUi.dismissTransientPrompts(4723, 'session')).resolves.toBe(2);
        expect(requests).toEqual([
            { path: '/session/session/context', method: 'GET' },
            {
                path: '/session/session/context',
                method: 'POST',
                body: { name: 'NATIVE_APP' },
            },
            {
                path: '/session/session/elements',
                method: 'POST',
                body: {
                    using: 'xpath',
                    value: "//*[contains(@resource-id, ':id/infobar_close_button') or contains(@resource-id, ':id/negative_button')]",
                },
            },
            {
                path: '/session/session/element/infobar-close/click',
                method: 'POST',
                body: {},
            },
            {
                path: '/session/session/element/negative-action/click',
                method: 'POST',
                body: {},
            },
            {
                path: '/session/session/context',
                method: 'POST',
                body: { name: 'WEBVIEW_chrome' },
            },
        ]);
    });
});
