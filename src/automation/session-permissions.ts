import { AndroidCameraUtilities } from './android-camera-utilities.js';
import type { BrowserHandle } from './browser-session.js';
import type { TargetConfig } from '../config/types.js';
import { TestbenchError } from '../errors/testbench-error.js';

interface OriginPermission {
    name: 'camera' | 'microphone' | 'geolocation' | 'notifications';
    origin: string;
}

export class SessionPermissions {
    private androidPermissions?: AndroidCameraUtilities;
    private originPermissions: Array<{ name: string; origin: string }> = [];
    metadata?: {
        requested: OriginPermission[];
        confirmed: OriginPermission[];
        packageName?: string;
    };

    constructor(
        private readonly appiumCommand: (
            path: string,
            body: Record<string, unknown>,
        ) => Promise<void>,
    ) {}

    async grantRedirect(
        target: TargetConfig,
        browser: BrowserHandle,
        requested: string,
        actual: string,
    ): Promise<boolean> {
        const permissions = this.metadata!;
        const requestedUrl = new URL(requested);
        const actualUrlValue = new URL(actual);
        const redirectedPermissions = permissions.requested
            .filter(
                (permission) =>
                    permission.origin === requestedUrl.origin &&
                    permission.origin !== actualUrlValue.origin &&
                    SessionPermissions.isEquivalentPermissionOrigin(requestedUrl, actualUrlValue),
            )
            .map((permission) => ({ ...permission, origin: actualUrlValue.origin }));

        for (const permission of redirectedPermissions) {
            try {
                await this.setOriginPermission(target, browser, permission, 'granted');
            } catch (error) {
                throw new TestbenchError(
                    'PERMISSION_DENIED',
                    `Could not grant ${permission.name} for redirected origin ${permission.origin}.`,
                    {
                        operation: 'permission.origin',
                        status: 403,
                        cause: error,
                        details: {
                            platform: target.name,
                            origin: permission.origin,
                            permission: permission.name,
                        },
                    },
                );
            }

            this.originPermissions.push(permission);
            permissions.confirmed.push(permission);
        }

        return redirectedPermissions.length > 0;
    }

    async restoreNative(): Promise<void> {
        await this.androidPermissions?.restore();
    }

    clear(): void {
        this.androidPermissions = undefined;
        this.originPermissions = [];
        this.metadata = undefined;
    }

    private static isEquivalentPermissionOrigin(requested: URL, actual: URL): boolean {
        const hostname = (url: URL): string => url.hostname.replace(/^www\./iu, '');
        return (
            requested.protocol === actual.protocol &&
            requested.port === actual.port &&
            hostname(requested) === hostname(actual)
        );
    }

    async prepare(
        target: TargetConfig,
        browser: BrowserHandle,
        requested: OriginPermission[],
    ): Promise<{ requested: typeof requested; confirmed: typeof requested; packageName?: string }> {
        let packageName: string | undefined;

        if (target.name === 'chrome-android') {
            const native = requested
                .map((permission) => permission.name)
                .filter(
                    (name): name is 'camera' | 'microphone' =>
                        name === 'camera' || name === 'microphone',
                );

            if (native.length) {
                this.androidPermissions = new AndroidCameraUtilities(target, browser.capabilities);
                packageName = (await this.androidPermissions.grant(native)).packageName;
            }
        }

        for (const permission of requested) {
            try {
                await this.setOriginPermission(target, browser, permission, 'granted');
            } catch (error) {
                throw new TestbenchError(
                    'PERMISSION_DENIED',
                    `Could not grant ${permission.name} for ${permission.origin}.`,
                    {
                        operation: 'permission.origin',
                        status: 403,
                        cause: error,
                        details: {
                            platform: target.name,
                            packageName,
                            origin: permission.origin,
                            permission: permission.name,
                        },
                    },
                );
            }

            this.originPermissions.push(permission);
        }

        this.metadata = {
            requested,
            confirmed: [...requested],
            ...(packageName ? { packageName } : {}),
        };
        return this.metadata;
    }

    async resetOrigins(target: TargetConfig, getBrowser: () => BrowserHandle): Promise<void> {
        if (!this.originPermissions.length) {
            return;
        }

        const permissions = this.originPermissions;
        const browser = getBrowser();
        this.originPermissions = [];
        const results = await Promise.allSettled(
            permissions.map((permission) =>
                this.setOriginPermission(target, browser, permission, 'prompt'),
            ),
        );
        const failures = results.filter(
            (result): result is PromiseRejectedResult => result.status === 'rejected',
        );

        if (failures.length) {
            throw new AggregateError(
                failures.map((failure) => failure.reason),
                'Could not reset origin permissions.',
            );
        }
    }

    private async setOriginPermission(
        target: TargetConfig,
        browser: BrowserHandle,
        permission: { name: string; origin: string },
        setting: 'granted' | 'denied' | 'prompt',
    ): Promise<void> {
        if (target.name !== 'chrome-android') {
            await browser.permission(permission.name, setting, permission.origin);
            return;
        }

        await this.appiumCommand('goog/cdp/execute', {
            cmd: 'Browser.setPermission',
            params: { permission: { name: permission.name }, setting, origin: permission.origin },
        });
    }
}
