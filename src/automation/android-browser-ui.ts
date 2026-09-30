import { AppiumSessionClient } from './appium-session-client.js';

export class AndroidBrowserUi {
    private static readonly dismissibleControls =
        "//*[contains(@resource-id, ':id/infobar_close_button') or " +
        "contains(@resource-id, ':id/negative_button')]";

    static async dismissTransientPrompts(appiumPort: number, sessionId: string): Promise<number> {
        const client = new AppiumSessionClient(appiumPort, sessionId);
        const original = await client.request<string>('context');

        try {
            await client.request('context', 'POST', { name: 'NATIVE_APP' });
            const elements = await client.request<Array<Record<string, string>>>(
                'elements',
                'POST',
                { using: 'xpath', value: this.dismissibleControls },
            );

            for (const element of elements) {
                const id = element['element-6066-11e4-a52e-4f735466cecf'] ?? element.ELEMENT;

                if (id) {
                    await client.request(`element/${encodeURIComponent(id)}/click`, 'POST', {});
                }
            }

            return elements.length;
        } finally {
            await client.request('context', 'POST', { name: original });
        }
    }
}
