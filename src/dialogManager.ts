import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import type Clutter from 'gi://Clutter';
import St from 'gi://St';
import GLib from 'gi://GLib';
import type Gio from 'gi://Gio';
import { BackdropGlass } from './rendering/backdropGlass.js';
import { hexToColorArray } from './animation/colors.js';
import { placeScreenGlass, GLASS_SHADOW_MAX_RADIUS } from './actors/glassBounds.js';
import { resolveMonitorGeometry, getTransformedRect, getAllocatedSize } from './actors/geometry.js';
import type { Logger } from './logger.js';

const SHADER_PADDING = 20;

export class DialogManager {
    private extensionPath: string;
    private _settings: Gio.Settings;
    private _logger: Logger;
    private _dialogStates: Map<Clutter.Actor, any>;
    private _signals: { obj: any; id: number }[];
    private _enabled: boolean;

    constructor(extensionPath: string, settings: Gio.Settings, logger: Logger) {
        this.extensionPath = extensionPath;
        this._settings = settings;
        this._logger = logger;
        this._dialogStates = new Map();
        this._signals = [];
        this._enabled = false;
    }

    setup() {
        if (!this._settings) return;
        this._enabled = true;
        this._bindSignals();
        this._scanExisting();
    }

    _bindSignals() {
        const group = Main.layoutManager.modalDialogGroup;
        if (group) {
            this._signals.push({
                obj: group,
                id: group.connect('child-added', (_g: any, child: Clutter.Actor) => this._onChildAdded(child)),
            });
            this._signals.push({
                obj: group,
                id: group.connect('child-removed', (_g: any, child: Clutter.Actor) => this._onChildRemoved(child)),
            });
        }
    }

    _scanExisting() {
        const group = Main.layoutManager.modalDialogGroup;
        if (!group) return;
        for (const child of group.get_children()) {
            this._onChildAdded(child);
        }
    }

    _findDialogBox(actor: Clutter.Actor | null): Clutter.Actor | null {
        if (!actor) return null;
        if (
            (actor as any).has_style_class_name?.('modal-dialog') ||
            (actor as any).has_style_class_name?.('run-dialog') ||
            (actor as any).has_style_class_name?.('prompt-dialog') ||
            (actor as any).has_style_class_name?.('pulsaros-about-dialog') ||
            (actor as any).has_style_class_name?.('pulsaros-power-dialog') ||
            (actor as any).has_style_class_name?.('end-session-dialog')
        ) {
            return actor;
        }
        if (actor.get_children) {
            for (const c of actor.get_children()) {
                const found = this._findDialogBox(c);
                if (found) return found;
            }
        }
        return null;
    }

    _onChildAdded(child: Clutter.Actor) {
        if (!this._enabled || !child) return;
        if ((child as any)._pulsarDialogGlass) return;
        GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            if (!this._enabled || !child || !child.get_parent()) return GLib.SOURCE_REMOVE;
            this._attachGlass(child);
            return GLib.SOURCE_REMOVE;
        });
    }

    _onChildRemoved(child: Clutter.Actor) {
        this._detachGlass(child);
    }

    _attachGlass(child: Clutter.Actor) {
        if (!child || (child as any)._pulsarDialogGlass) return;
        if (this._dialogStates.has(child)) return;

        const targetBox = this._findDialogBox(child);
        if (!targetBox) return;

        this._logger?.log?.(`[Liquid Glass] Attached dialog glass to: ${targetBox}`);

        const origStyle = (targetBox as any).get_style?.() || '';
        if (typeof (targetBox as any).add_style_class_name === 'function')
            (targetBox as any).add_style_class_name('liquid-glass-transparent');

        // Clear targetBox background so liquid glass shines through cleanly.
        // Keep the border: the stylesheet draws it on top of the glass.
        (targetBox as any).set_style?.(`${origStyle ? origStyle + '; ' : ''}background-color: transparent !important; background-image: none !important; box-shadow: none !important;`);

        const glass = new BackdropGlass({
            extensionPath: this.extensionPath,
            settings: this._settings,
            logger: this._logger,
            owner: 'dialog',
        } as any);
        glass.set_pivot_point(0.0, 0.0);
        (glass as any)._pulsarDialogGlass = true;
        if (typeof (glass as any).set_no_layout === 'function') {
            (glass as any).set_no_layout(true);
        }

        // A glass added to modalDialogGroup would be painted *below* the
        // Lightbox shade and the dialog would look transparent and borderless.
        // Instead, put it inside ModalDialog.backgroundStack: the lightbox
        // raises that whole stack above the shade (via highlight()), the glass
        // sits below the dialog content and still copies the scene behind it.
        const dialogLayout = (targetBox as any).get_parent?.() || null;
        const backgroundStack = (dialogLayout as any)?.get_parent?.() || null;
        const inStack = !!(backgroundStack as any)?.layout_manager;
        const host: Clutter.Actor = inStack
            ? backgroundStack
            : (child.get_parent() || Main.layoutManager.modalDialogGroup);
        host.insert_child_at_index(glass, 0);

        let cornerRadius = 18.0;
        let tintColorStr = '#ffffff';
        try { tintColorStr = this._settings.get_string('panel-menu-tint-color') || '#ffffff'; } catch (e) {}
        let tintStrength = 0.12;
        try { tintStrength = this._settings.get_double('panel-menu-tint-strength') || 0.12; } catch (e) {}
        let blurRadius = 16;
        try { blurRadius = this._settings.get_int('panel-menu-blur-radius') || 16; } catch (e) {}

        glass.setPadding(SHADER_PADDING);
        glass.setTintColor(...hexToColorArray(tintColorStr));
        glass.setTintStrength(tintStrength);
        glass.setCornerRadius(cornerRadius);
        glass.setIsDock(false);
        glass.setBlurRadius(blurRadius);
        glass.setBrightness(1.0);
        glass.setContrast(1.05);
        glass.setSaturation(1.4);

        let lastMonitorX: number | null = null, lastMonitorY: number | null = null;
        let lastScreenW: number | null = null, lastScreenH: number | null = null;
        let lastLocalBgX: number | null = null, lastLocalBgY: number | null = null;
        let lastBgW: number | null = null, lastBgH: number | null = null;

        const syncGeometry = () => {
            if (!child || !targetBox || !glass) return;
            if (!child.visible || targetBox.opacity === 0 || !targetBox.mapped) {
                glass.hide();
                return;
            }
            try {
                const monitor = resolveMonitorGeometry([targetBox, child]) || Main.layoutManager.primaryMonitor;
                const monitorX = monitor?.x ?? 0;
                const monitorY = monitor?.y ?? 0;
                const screenW = Math.max(1, monitor?.width ?? 1);
                const screenH = Math.max(1, monitor?.height ?? 1);

                const [tx, ty, tw, th] = getTransformedRect(targetBox);
                const [aw, ah] = getAllocatedSize(targetBox);
                const w = (tw > 0) ? tw : aw;
                const h = (th > 0) ? th : ah;

                if (w > 1 && h > 1) {
                    const bgW = Math.round(w + SHADER_PADDING * 2);
                    const bgH = Math.round(h + SHADER_PADDING * 2);
                    const bgX = Math.round(tx - SHADER_PADDING);
                    const bgY = Math.round(ty - SHADER_PADDING);
                    const localBgX = bgX - monitorX;
                    const localBgY = bgY - monitorY;

                    if (
                        lastMonitorX !== monitorX || lastMonitorY !== monitorY ||
                        lastScreenW !== screenW || lastScreenH !== screenH ||
                        lastLocalBgX !== localBgX || lastLocalBgY !== localBgY ||
                        lastBgW !== bgW || lastBgH !== bgH
                    ) {
                        // Inside backgroundStack the glass is positioned at the
                        // monitor-local origin; the clip it receives is already
                        // monitor-local in both cases.
                        placeScreenGlass(
                            glass,
                            inStack ? 0 : monitorX,
                            inStack ? 0 : monitorY,
                            screenW, screenH,
                            { x: localBgX, y: localBgY, w: bgW, h: bgH }
                        );
                        glass.setShadowMaxRadius(GLASS_SHADOW_MAX_RADIUS);
                        glass.setResolution(screenW, screenH);
                        glass.setGlassGeometry(localBgX, localBgY, bgW, bgH);

                        try {
                            const themeNode = (targetBox as any).get_theme_node?.();
                            if (themeNode) {
                                const r = themeNode.get_length?.('-border-radius') || themeNode.get_border_radius?.(St.Corner.TOPLEFT);
                                if (r > 0) cornerRadius = r;
                            }
                        } catch (e) {}
                        glass.setCornerRadius(cornerRadius);

                        glass.syncSources();

                        lastMonitorX = monitorX;
                        lastMonitorY = monitorY;
                        lastScreenW = screenW;
                        lastScreenH = screenH;
                        lastLocalBgX = localBgX;
                        lastLocalBgY = localBgY;
                        lastBgW = bgW;
                        lastBgH = bgH;
                    }

                    if (!glass.visible) glass.show();
                    if (inStack) {
                        // The glass already inherits ModalDialog's fade opacity;
                        // copying the paint opacity here would apply it twice.
                        const layoutOpacity = (dialogLayout as any)?.opacity ?? 255;
                        glass.opacity = Math.min(layoutOpacity, targetBox.opacity);
                    } else {
                        const childOpacity = child.get_paint_opacity ? child.get_paint_opacity() : child.opacity;
                        const boxOpacity = (targetBox as any).get_paint_opacity ? (targetBox as any).get_paint_opacity() : targetBox.opacity;
                        glass.opacity = Math.min(childOpacity, boxOpacity);
                    }
                }
            } catch (e) {
                this._logger?.error?.(`[DialogManager] syncGeometry error: ${e}`);
            }
        };

        glass.setLiveGeometryHook(syncGeometry);

        const conns = [
            child.connect('notify::allocation', syncGeometry),
            child.connect('notify::visible', syncGeometry),
            child.connect('notify::opacity', syncGeometry),
            child.connect('notify::mapped', syncGeometry),
            targetBox.connect('notify::allocation', syncGeometry),
            targetBox.connect('notify::visible', syncGeometry),
            targetBox.connect('notify::opacity', syncGeometry),
            targetBox.connect('notify::mapped', syncGeometry),
        ];

        let animFrames = 0;
        const animTimerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 16, () => {
            animFrames++;
            syncGeometry();
            if (animFrames > 35 || !glass.get_parent() || !child.get_parent()) {
                return GLib.SOURCE_REMOVE;
            }
            return GLib.SOURCE_CONTINUE;
        });

        const destroyId = child.connect('destroy', () => {
            this._dialogStates.delete(child);
            if (animTimerId) {
                try { GLib.source_remove(animTimerId); } catch (e) {}
            }
            try { (targetBox as any).set_style?.(origStyle || null); } catch (e) {}
            try { glass.destroy(); } catch (e) {}
        });

        this._dialogStates.set(child, { targetBox, glass, conns, animTimerId, origStyle, destroyId });
        syncGeometry();
    }

    _detachGlass(child: Clutter.Actor) {
        const state = this._dialogStates.get(child);
        if (!state) return;
        this._dialogStates.delete(child);

        if (state.animTimerId) {
            try { GLib.source_remove(state.animTimerId); } catch (e) {}
        }
        for (const id of state.conns) {
            try { child.disconnect(id); } catch (e) {}
            try { state.targetBox.disconnect(id); } catch (e) {}
        }
        if (state.destroyId) {
            try { child.disconnect(state.destroyId); } catch (e) {}
        }
        try { state.targetBox.remove_style_class_name?.('liquid-glass-transparent'); } catch (e) {}
        try { state.targetBox.set_style?.(state.origStyle || null); } catch (e) {}
        try { state.glass.destroy(); } catch (e) {}
    }

    destroy() {
        this._enabled = false;
        for (const s of this._signals) {
            try { s.obj.disconnect(s.id); } catch (e) {}
        }
        this._signals = [];
        for (const child of [...this._dialogStates.keys()]) {
            this._detachGlass(child);
        }
    }
}
