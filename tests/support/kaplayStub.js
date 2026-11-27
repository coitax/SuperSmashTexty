// Enough of the Kaplay surface for the game scene to register its
// multiplayer message handlers and build the local player. Drawing is a no-op.
// The scene function, player factory, and save code are the real modules.

function entity() {
    return {
        pos: {
            x: 0,
            y: 0,
            clone() {
                return { x: this.x, y: this.y };
            }
        },
        angle: 0,
        opacity: 1,
        hidden: false,
        color: [255, 255, 255],
        outline: { color: [255, 255, 255], width: 1, opacity: 1 },
        scale: { x: 1, y: 1 },
        z: 0,
        width: 10,
        height: 10,
        tags: [],
        text: '',
        level: 1,
        xp: 0,
        xpToNext: 10,
        maxHealth: 100,
        isDead: false,
        canMove: true,
        canShoot: true,
        exists() {
            return true;
        },
        destroy() {},
        onUpdate() {},
        onHover() {},
        onHoverEnd() {},
        onClick() {},
        onDeath() {},
        onDestroy() {},
        use() {},
        hp() {
            return this.maxHealth;
        },
        setHP() {},
        is() {
            return false;
        },
        move: { x: 0, y: 0 }
    };
}

export function createKaplayStub() {
    const scenes = new Map();
    const k = {
        lastSceneError: null,
        paused: false,
        gameData: {},
        canvas: { width: 800, height: 600, addEventListener() {} },
        scene(name, fn) {
            scenes.set(name, fn);
        },
        go(name, args) {
            const fn = scenes.get(name);
            if (!fn) {
                throw new Error(`scene not registered: ${name}`);
            }
            try {
                fn(args);
            } catch (error) {
                k.lastSceneError = error;
                throw error;
            }
        },
        width: () => 800,
        height: () => 600,
        center: () => k.vec2(400, 300),
        rgb: (...channels) => channels,
        vec2(x = 0, y = 0) {
            return {
                x,
                y,
                len() {
                    return Math.hypot(this.x, this.y);
                },
                scale(n) {
                    return k.vec2(this.x * n, this.y * n);
                },
                clone() {
                    return k.vec2(this.x, this.y);
                },
                add(other) {
                    return k.vec2(this.x + (other?.x || 0), this.y + (other?.y || 0));
                },
                sub(other) {
                    return k.vec2(this.x - (other?.x || 0), this.y - (other?.y || 0));
                }
            };
        },
        add() {
            return entity();
        },
        destroy() {},
        get() {
            return [];
        },
        onUpdate() {
            return { cancel() {}, paused: false };
        },
        onDraw() {
            return { cancel() {} };
        },
        onKeyDown() {
            return { cancel() {} };
        },
        onKeyPress() {
            return { cancel() {} };
        },
        onKeyRelease() {
            return { cancel() {} };
        },
        onClick() {},
        onMouseMove() {},
        onMousePress() {},
        onMouseRelease() {},
        onCharInput() {},
        onGamepadButtonPress() {},
        wait() {},
        loop() {
            return { cancel() {} };
        },
        tween() {
            return { onEnd() { return this; } };
        },
        dt: () => 0.016,
        time: () => 0,
        camPos() {
            return k.vec2(400, 300);
        },
        camScale() {},
        shake() {},
        debug: { log() {}, error() {}, inspect: false },
        quad: () => 0,
        easings: { easeOutQuad: () => 0 }
    };

    return new Proxy(k, {
        get(target, prop) {
            if (prop in target) return target[prop];
            if (prop === 'then') return undefined;
            return () => ({});
        }
    });
}
