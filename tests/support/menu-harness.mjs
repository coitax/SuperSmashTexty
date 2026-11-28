/**
 * Runs the real menu scene function (src/scenes/menu.js setupMenuScene).
 * Kaplay itself is not started: the scene only needs the k methods it calls
 * while building the party list. Text arguments are recorded as menu.js
 * passes them to k.text, which is the value the text component receives.
 */

export function createMenuHarness() {
    const texts = [];
    const updates = [];
    const tagged = new Map();
    let sceneFn = null;

    function vec2(x = 0, y = x) {
        return {
            x,
            y,
            add(other) {
                return vec2(this.x + (other?.x || 0), this.y + (other?.y || 0));
            },
            scale(factor) {
                return vec2(this.x * factor, this.y * factor);
            },
        };
    }

    function makeEntity(components) {
        const list = components.filter(Boolean);
        const text = list.find((component) => component && component.__text);
        const pos = list.find((component) => component && component.__pos);
        const entity = {
            _destroyed: false,
            exists() {
                return !this._destroyed;
            },
            pos: vec2(pos?.x ?? 0, pos?.y ?? 0),
            text: text ? text.content : '',
            color: [0, 0, 0],
            outline: { color: [0, 0, 0] },
            scale: vec2(1, 1),
            opacity: 1,
            hidden: false,
            isHovered: false,
            disabled: false,
            labels: [],
            onClick() {},
            onHoverUpdate() {},
            onHoverEnd() {},
            onUpdate() {},
        };

        for (const component of list) {
            if (typeof component === 'string') {
                if (!tagged.has(component)) {
                    tagged.set(component, []);
                }
                tagged.get(component).push(entity);
            }
        }

        return entity;
    }

    const k = {
        scene(_name, fn) {
            sceneFn = fn;
        },
        add(components) {
            return makeEntity(components);
        },
        get(tag) {
            return tagged.get(tag) || [];
        },
        destroy(entity) {
            if (entity) {
                entity._destroyed = true;
            }
        },
        text(content, opts = {}) {
            texts.push({ content, size: opts.size });
            return { __text: true, content, opts };
        },
        pos(x, y) {
            return { __pos: true, x, y };
        },
        rect() {
            return {};
        },
        color() {
            return {};
        },
        outline() {
            return {};
        },
        area() {
            return {};
        },
        anchor() {
            return {};
        },
        fixed() {
            return {};
        },
        z() {
            return {};
        },
        scale() {
            return {};
        },
        opacity() {
            return {};
        },
        rgb(...channels) {
            return channels;
        },
        vec2,
        width() {
            return 800;
        },
        height() {
            return 600;
        },
        dt() {
            return k._dt;
        },
        time() {
            return 0;
        },
        go() {},
        onUpdate(fn) {
            updates.push(fn);
            return { cancel() {} };
        },
        onClick() {
            return { cancel() {} };
        },
        onKeyPress() {
            return { cancel() {} };
        },
        onSceneLeave() {},
        loop() {
            return { cancel() {} };
        },
        wait() {},
        _dt: 0,
    };

    function enter() {
        if (!sceneFn) {
            throw new Error('Menu scene was not registered');
        }
        sceneFn();
    }

    /**
     * Advance the scene clock by one second and run every onUpdate the menu
     * registered, including the party-list refresh (menu.js, lastPartyCheck >= 1).
     */
    function refreshPartyList() {
        k._dt = 1;
        for (const update of updates) {
            update();
        }
        k._dt = 0;
    }

    function levelBadgeTexts() {
        return texts.filter((entry) => entry.size === 8).map((entry) => entry.content);
    }

    return { k, enter, refreshPartyList, levelBadgeTexts, texts };
}
