const canvas = document.getElementById("simCanvas");
const ctx = canvas.getContext("2d");
const rollBtn = document.getElementById("rollBtn");
const resultText = document.getElementById("resultText");

const earthImage = new Image();
// Prefer PNG then fall back to SVG
earthImage.src = "assets/image.jpg";
earthImage.onerror = () => {
    if (!earthImage.src.endsWith("earth.svg"))
        earthImage.src = "assets/earth.svg";
};

const dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
const logicalSize = 760;
canvas.width = logicalSize * dpr;
canvas.height = logicalSize * dpr;
ctx.scale(dpr, dpr);

const world = {
    w: logicalSize,
    h: logicalSize,
    cx: logicalSize / 2,
    cy: logicalSize / 2,
    arenaRadius: logicalSize * 0.44,
    diceColors: ["#ffb000", "#fe6100", "#dc267f", "#785ef0", "#648fff"],
    diceRadius: 32,
    earthOrbitRadius: logicalSize * 0.48,
    // slower orbit for a gentler rotation
    earthOrbitSpeed: 0.06,
    earthScale: 0.8,
    time: 0,
    state: "idle",
    rollEndAt: 0,
    settleEndAt: 0,
    rollStart: 0,
    allowFinalize: false,
    arm: {
        angle: 0,
        spinVel: 0,
        length: 0, // set later when sizes are known
        thickness: 0,
    },
};

const pipPatterns = {
    1: [[0, 0]],
    2: [
        [-1, -1],
        [1, 1],
    ],
    3: [
        [-1, -1],
        [0, 0],
        [1, 1],
    ],
    4: [
        [-1, -1],
        [1, -1],
        [-1, 1],
        [1, 1],
    ],
    5: [
        [-1, -1],
        [1, -1],
        [0, 0],
        [-1, 1],
        [1, 1],
    ],
    6: [
        [-1, -1],
        [1, -1],
        [-1, 0],
        [1, 0],
        [-1, 1],
        [1, 1],
    ],
};

// Matter.js setup (provided by CDN in index.html)
const { Engine, Composite, Bodies, Body } = Matter;
const engine = Engine.create();
engine.world.gravity.x = 0;
engine.world.gravity.y = 0;
// increase solver iterations to reduce tunneling/ejection at boundaries
engine.positionIterations = 8;
engine.velocityIterations = 6;
engine.constraintIterations = 4;

// Create dice as Matter bodies and keep display/face state separately
const dice = [];
const dieSize = world.diceRadius * 2;
const initialOrbit = world.arenaRadius * 0.48;
const diceCount = world.diceColors.length;
for (let i = 0; i < diceCount; i += 1) {
    const angle = (Math.PI * 2 * i) / diceCount;
    const x = world.cx + Math.cos(angle) * initialOrbit;
    const y = world.cy + Math.sin(angle) * initialOrbit;

    const body = Bodies.rectangle(x, y, dieSize, dieSize, {
        restitution: 0.88,
        friction: 0.02,
        frictionAir: 0.06,
        density: 0.002,
    });

    // set initial random orientation explicitly
    Body.setAngle(body, Math.random() * Math.PI * 2);

    Composite.add(engine.world, body);

    dice.push({
        body,
        value: 1 + Math.floor(Math.random() * 6),
        nextFaceChangeAt: 0,
        color: world.diceColors[i % world.diceColors.length],
        lastArmHitAt: 0,
    });
}

// finalize arm dimensions now that die size is known
world.arm.length = world.arenaRadius; // equal to arena radius as requested
world.arm.thickness = dieSize / 2; // half the width of a die

// create a dynamic physics body for the arm and pin one end to the arena center
// so it behaves like a motor-driven clock arm (one end at center, other at edge)
{
    const a = world.arm.angle;
    const halfLen = world.arm.length / 2;
    // place the arm body's center at the correct offset so one end is at the pivot
    const cx = world.cx + Math.cos(a) * halfLen;
    const cy = world.cy + Math.sin(a) * halfLen;

    // create a static body and we'll manually set its angle/position each frame
    const armBody = Bodies.rectangle(
        cx,
        cy,
        world.arm.length,
        world.arm.thickness,
        {
            isStatic: true,
            restitution: 0.6,
            friction: 0.02,
        },
    );
    Composite.add(engine.world, armBody);

    world.arm.body = armBody;
    world.arm.motorSpeed = 3; // radians/sec
}

// Create an approximated circular ring made from many static segments
// so dice can stay inside without colliding with a filled circle.
const wallThickness = Math.max(12, Math.round(world.diceRadius * 0.45));
const wallCount = 48;
const wallRadius = world.arenaRadius - wallThickness / 2;
for (let i = 0; i < wallCount; i += 1) {
    const a = (i / wallCount) * Math.PI * 2;
    const cx = world.cx + Math.cos(a) * wallRadius;
    const cy = world.cy + Math.sin(a) * wallRadius;
    const arcLen = (2 * Math.PI * world.arenaRadius) / wallCount;
    const seg = Bodies.rectangle(cx, cy, arcLen * 1.1, wallThickness, {
        isStatic: true,
        restitution: 0.92,
        friction: 0.02,
        angle: a + Math.PI / 2,
    });
    Composite.add(engine.world, seg);
}

// Define an enforcement radius (inner usable area) to nudge dice inside
const boundaryRadius = world.arenaRadius - world.diceRadius - 1.5;

function drawSpaceBackdrop() {
    ctx.save();
    const g = ctx.createRadialGradient(
        world.cx,
        world.cy,
        90,
        world.cx,
        world.cy,
        world.w * 0.55,
    );
    g.addColorStop(0, "#061337");
    g.addColorStop(1, "#01050f");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, world.w, world.h);

    for (let i = 0; i < 170; i += 1) {
        const x = (i * 127.1) % world.w;
        const y = (i * 347.7) % world.h;
        const alpha = 0.15 + ((i * 29) % 100) / 130;
        ctx.fillStyle = `rgba(214,231,255,${alpha.toFixed(2)})`;
        ctx.fillRect(x, y, 1.6, 1.6);
    }
    ctx.restore();
}

function drawEarth() {
    const angle = world.time * world.earthOrbitSpeed;
    const earthSize = world.w * world.earthScale;
    const x = world.cx + Math.cos(angle) * world.earthOrbitRadius;
    const y = world.cy + Math.sin(angle) * world.earthOrbitRadius;

    ctx.save();
    ctx.globalAlpha = 0.78;
    if (earthImage.complete) {
        ctx.drawImage(
            earthImage,
            x - earthSize / 2,
            y - earthSize / 2,
            earthSize,
            earthSize,
        );
    } else {
        ctx.fillStyle = "#2a8fdc";
        ctx.beginPath();
        ctx.arc(x, y, earthSize * 0.5, 0, Math.PI * 2);
        ctx.fill();
    }
    ctx.restore();
}

function drawArena() {
    ctx.save();
    const g = ctx.createRadialGradient(
        world.cx,
        world.cy,
        world.arenaRadius * 0.2,
        world.cx,
        world.cy,
        world.arenaRadius,
    );
    g.addColorStop(0, "rgba(147,197,253,0.1)");
    g.addColorStop(1, "rgba(96,165,250,0.02)");
    ctx.fillStyle = g;

    ctx.beginPath();
    ctx.arc(world.cx, world.cy, world.arenaRadius, 0, Math.PI * 2);
    ctx.fill();

    ctx.strokeStyle = "rgba(147,197,253,0.85)";
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.arc(world.cx, world.cy, world.arenaRadius, 0, Math.PI * 2);
    ctx.stroke();

    ctx.strokeStyle = "rgba(186,223,255,0.25)";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(world.cx, world.cy, world.arenaRadius - 8, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
}

function drawDie(die) {
    const size = world.diceRadius * 2;
    const corner = 8;
    const pattern = pipPatterns[die.value];

    const pos = die.body.position;
    const ang = die.body.angle;

    ctx.save();
    ctx.translate(pos.x, pos.y);
    ctx.rotate(ang);

    ctx.fillStyle = die.color ?? "#f8fafc";
    ctx.strokeStyle = "#cbd5e1";
    ctx.lineWidth = 2;

    ctx.beginPath();
    ctx.moveTo(-size / 2 + corner, -size / 2);
    ctx.lineTo(size / 2 - corner, -size / 2);
    ctx.quadraticCurveTo(size / 2, -size / 2, size / 2, -size / 2 + corner);
    ctx.lineTo(size / 2, size / 2 - corner);
    ctx.quadraticCurveTo(size / 2, size / 2, size / 2 - corner, size / 2);
    ctx.lineTo(-size / 2 + corner, size / 2);
    ctx.quadraticCurveTo(-size / 2, size / 2, -size / 2, size / 2 - corner);
    ctx.lineTo(-size / 2, -size / 2 + corner);
    ctx.quadraticCurveTo(-size / 2, -size / 2, -size / 2 + corner, -size / 2);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = "#ffffff";
    const pipOffset = size * 0.23;
    const pipRadius = size * 0.08;
    pattern.forEach(([px, py]) => {
        ctx.beginPath();
        ctx.arc(px * pipOffset, py * pipOffset, pipRadius, 0, Math.PI * 2);
        ctx.fill();
    });

    ctx.restore();
}

function applyMotion(dt) {
    const now = world.time;

    // update arm before physics step so hits immediately affect velocities
    updateArm(dt);

    // Step Matter engine (Engine.update expects ms)
    Engine.update(engine, dt * 1000);

    if (world.state === "rolling" && now >= world.rollEndAt) {
        world.state = "settling";
    }

    if (now >= world.settleEndAt) {
        world.allowFinalize = true;
    }

    if (world.allowFinalize && world.state !== "stopped") {
        const calm = dice.every((d) => {
            const v = d.body.velocity;
            return (
                Math.hypot(v.x, v.y) < 0.6 &&
                Math.abs(d.body.angularVelocity) < 0.06
            );
        });
        const forcedTimeout = now >= world.settleEndAt + 5.0;

        if (calm || forcedTimeout) {
            world.state = "stopped";
            let total = 0;
            dice.forEach((die) => {
                total += die.value;
            });
            resultText.textContent = `${dice.map((d) => d.value).join(" + ")} = ${total}`;
        }
    }

    updateFaceDisplays(now);
}

function easeOutCubic(t) {
    return 1 - Math.pow(1 - t, 3);
}

function updateFaceDisplays(now) {
    // Change face display frequency based purely on each die's linear speed.
    // High speed -> rapid random face changes. Low/standing still -> few or no changes.
    const minInterval = 0.04; // fastest change interval (sec)
    const maxInterval = 0.8; // slowest change interval (sec)
    const maxSpeedForPips = 5.0;
    const stillThreshold = 0.001; // below this speed we consider the die "still"

    dice.forEach((die) => {
        const v = die.body.velocity;
        const speed = Math.hypot(v.x, v.y);
        const speedNorm = Math.max(0, Math.min(1, speed / maxSpeedForPips));

        if (speed < stillThreshold) {
            return;
        }

        // Interpolate interval: high speed -> near minInterval, low speed -> near maxInterval
        const perDieInterval =
            minInterval + (maxInterval - minInterval) * (1 - speedNorm);

        if (now >= die.nextFaceChangeAt) {
            die.value = 1 + Math.floor(Math.random() * 6);
            die.nextFaceChangeAt = 0;
        }

        const nextFaceChange = now + perDieInterval;
        if (die.nextFaceChangeAt === 0) {
            die.nextFaceChangeAt = nextFaceChange;
        } else {
            die.nextFaceChangeAt = Math.min(
                die.nextFaceChangeAt,
                nextFaceChange,
            );
        }
    });
}

function draw() {
    ctx.clearRect(0, 0, world.w, world.h);

    // Metal grey outer background
    ctx.save();
    const metal = ctx.createLinearGradient(0, 0, world.w, world.h);
    metal.addColorStop(0, "#4b5563");
    metal.addColorStop(0.5, "#6b7280");
    metal.addColorStop(1, "#374151");
    ctx.fillStyle = metal;
    ctx.fillRect(0, 0, world.w, world.h);

    // Clip to arena and draw space inside
    ctx.beginPath();
    ctx.arc(world.cx, world.cy, world.arenaRadius, 0, Math.PI * 2);
    ctx.clip();

    drawSpaceBackdrop();
    drawEarth();
    ctx.restore();

    drawArena();
    drawArm();
    dice.forEach(drawDie);
}

function drawArm() {
    const len = world.arm.length;
    const t = world.arm.thickness;
    const body = world.arm.body;
    if (!body) return;

    ctx.save();
    ctx.translate(body.position.x, body.position.y);
    ctx.rotate(body.angle);
    ctx.fillStyle = "rgba(255,255,255,0.12)";
    ctx.strokeStyle = "rgba(255,255,255,0.22)";
    ctx.lineWidth = 2;
    // draw rectangle centered on body (body is centered at half-length)
    ctx.beginPath();
    ctx.rect(-len / 2, -t / 2, len, t);
    ctx.fill();
    ctx.stroke();
    ctx.restore();
}

function updateArm(dt) {
    const arm = world.arm;
    const halfLen = arm.length / 2;

    if (world.time <= world.rollEndAt) {
        const currentAngle = arm.body.angle;
        const nextAngle = currentAngle + arm.motorSpeed * dt;

        const halfLen = world.arm.length / 2;
        const nextX = world.cx + Math.cos(nextAngle) * halfLen;
        const nextY = world.cy + Math.sin(nextAngle) * halfLen;

        const velX = (nextX - arm.body.position.x) / dt / 100;
        const velY = (nextY - arm.body.position.y) / dt / 100;

        Body.setPosition(arm.body, { x: nextX, y: nextY });
        Body.setAngle(arm.body, nextAngle);

        console.log(`Arm velocity: (${velX.toFixed(2)}, ${velY.toFixed(2)})`);

        Body.setVelocity(arm.body, { x: velX, y: velY });
    } else {
        Body.setVelocity(arm.body, { x: 0, y: 0 });
    }
}

let prevTs = performance.now();
function frame(ts) {
    const dt = Math.min(0.033, (ts - prevTs) / 1000);
    prevTs = ts;
    world.time += dt;

    applyMotion(dt);
    draw();

    requestAnimationFrame(frame);
}

rollBtn.addEventListener("click", () => {
    world.state = "rolling";
    world.rollStart = world.time;
    world.rollEndAt = world.rollStart + 3.5;
    world.settleEndAt = world.rollEndAt + 2.1;
    world.allowFinalize = false;
    resultText.textContent = "rolling...";
});

// removed automatic random scatter on load to avoid immediate ejection
requestAnimationFrame(frame);
