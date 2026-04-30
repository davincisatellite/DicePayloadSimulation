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
    arenaRadius: logicalSize * 0.36,
    diceCount: 5,
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

// Palette for the five dice (provided by user)
const diceColors = ["#ffb000", "#fe6100", "#dc267f", "#785ef0", "#648fff"];

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
for (let i = 0; i < world.diceCount; i += 1) {
    const angle = (Math.PI * 2 * i) / world.diceCount;
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
        displayValue: 1 + Math.floor(Math.random() * 6),
        targetValue: null,
        nextFaceChangeAt: 0,
        color: diceColors[i % diceColors.length],
        lastArmHitAt: 0,
    });
}

// finalize arm dimensions now that die size is known
world.arm.length = world.arenaRadius; // equal to arena radius as requested
world.arm.thickness = dieSize / 2; // half the width of a die

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

// helper: clamp and nudge dice back inside the arena to prevent ejection
function enforceArena(die) {
    const pos = die.body.position;
    const dx = pos.x - world.cx;
    const dy = pos.y - world.cy;
    const dist = Math.hypot(dx, dy);
    const max = boundaryRadius - world.diceRadius * 0.5;
    if (dist > max) {
        const nx = dx / dist || 0;
        const ny = dy / dist || 0;
        // place slightly inside and reduce velocity to avoid bounce-out
        Body.setPosition(die.body, {
            x: world.cx + nx * max,
            y: world.cy + ny * max,
        });
        Body.setVelocity(die.body, {
            x: die.body.velocity.x * 0.28,
            y: die.body.velocity.y * 0.28,
        });
        Body.setAngularVelocity(die.body, die.body.angularVelocity * 0.35);
    }
}

function randomizeEnergies(base = 260) {
    dice.forEach((die) => {
        const b = die.body;
        // reduce initial momentum: lower speedScale so initial impulses are gentler
        const speedScale = 0.012;
        const vx = (Math.random() - 0.5) * base * speedScale;
        const vy = (Math.random() - 0.5) * base * speedScale;
        Body.setVelocity(b, { x: vx, y: vy });
        Body.setAngularVelocity(b, (Math.random() - 0.5) * 3.2);
    });
}

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
    const pattern = pipPatterns[die.displayValue ?? die.value];

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

    // Stabilize tiny velocities to prevent perpetual micro-jitter
    dice.forEach((die) => {
        const v = die.body.velocity;
        const speed = Math.hypot(v.x, v.y);
        const maxSpeed = 6.0;
        if (speed > maxSpeed) {
            // clamp very large velocities
            Body.setVelocity(die.body, {
                x: (v.x / speed) * maxSpeed,
                y: (v.y / speed) * maxSpeed,
            });
        } else if (
            (world.state === "settling" || world.allowFinalize) &&
            speed < 0.6
        ) {
            Body.setVelocity(die.body, { x: 0, y: 0 });
        } else if (speed < 0.02) {
            Body.setVelocity(die.body, { x: 0, y: 0 });
        }

        const av = die.body.angularVelocity;
        if (
            (world.state === "settling" || world.allowFinalize) &&
            Math.abs(av) < 0.03
        ) {
            Body.setAngularVelocity(die.body, 0);
        } else if (Math.abs(av) < 0.002) {
            Body.setAngularVelocity(die.body, 0);
        }
    });

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
        const facesSettled = dice.every(
            (d) => d.displayValue === d.targetValue,
        );
        const forcedTimeout = now >= world.settleEndAt + 5.0;

        if ((calm && facesSettled) || forcedTimeout) {
            world.state = "stopped";
            let total = 0;
            dice.forEach((die) => {
                die.value = die.displayValue ?? die.value;
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
    const rollStart = world.rollStart ?? world.rollEndAt - 1.5;
    const totalDuration = Math.max(0.001, world.settleEndAt - rollStart);
    const progress = Math.min(
        1,
        Math.max(0, (now - rollStart) / totalDuration),
    );

    const minInterval = 0.04;
    const maxInterval = 0.6;
    const eased = easeOutCubic(progress);
    const baseInterval = minInterval + (maxInterval - minInterval) * eased;

    // Make the pip-change speed depend on each die's speed:
    // faster dice -> smaller interval -> quicker dot changes
    const maxSpeedForPips = 6.0;
    dice.forEach((die) => {
        const v = die.body.velocity;
        const speed = Math.hypot(v.x, v.y);
        const speedNorm = Math.max(0, Math.min(1, speed / maxSpeedForPips));
        const perDieInterval = baseInterval * (1 - 0.85 * speedNorm);

        if (!die.nextFaceChangeAt)
            die.nextFaceChangeAt = now + Math.random() * perDieInterval;

        if (now >= die.nextFaceChangeAt) {
            if (progress < 0.98) {
                die.displayValue = 1 + Math.floor(Math.random() * 6);
            } else {
                die.displayValue = die.targetValue ?? die.displayValue;
            }

            die.nextFaceChangeAt =
                now + perDieInterval * (0.7 + Math.random() * 0.6);
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
    const a = world.arm.angle;
    const len = world.arm.length;
    const t = world.arm.thickness;

    ctx.save();
    ctx.translate(world.cx, world.cy);
    ctx.rotate(a);
    ctx.fillStyle = "rgba(255,255,255,0.12)";
    ctx.strokeStyle = "rgba(255,255,255,0.22)";
    ctx.lineWidth = 2;
    // draw rectangle arm from center outward
    ctx.beginPath();
    ctx.moveTo(0, -t / 2);
    ctx.lineTo(len, -t / 2);
    ctx.lineTo(len, t / 2);
    ctx.lineTo(0, t / 2);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();
}

function updateArm(dt) {
    // integrate spin
    const arm = world.arm;
    if (Math.abs(arm.spinVel) > 0.0001) {
        arm.angle += arm.spinVel * dt;
        // decay spin velocity
        const decayRate = 3.0; // seconds to slow down
        arm.spinVel -= arm.spinVel * decayRate * dt;

        // check collisions with dice
        const now = world.time;
        const armDir = { x: Math.cos(arm.angle), y: Math.sin(arm.angle) };

        dice.forEach((die) => {
            const pos = die.body.position;
            const dx = pos.x - world.cx;
            const dy = pos.y - world.cy;
            // projection length along arm (0..len)
            const proj = dx * armDir.x + dy * armDir.y;
            const clamped = Math.max(0, Math.min(arm.length, proj));
            const closestX = world.cx + armDir.x * clamped;
            const closestY = world.cy + armDir.y * clamped;
            const dist = Math.hypot(pos.x - closestX, pos.y - closestY);

            const hitRadius = world.diceRadius + arm.thickness / 2;
            const hitCooldown = 0.12;
            if (
                dist <= hitRadius &&
                now - (die.lastArmHitAt || 0) > hitCooldown
            ) {
                die.lastArmHitAt = now;

                // impart tangential impulse based on spin velocity
                // tangential is perpendicular to armDir
                const tang = { x: -armDir.y, y: armDir.x };
                // direction sign depends on spin sign
                const sign = Math.sign(arm.spinVel) || 1;
                const tangDir = { x: tang.x * sign, y: tang.y * sign };

                // compute impulse magnitude (tweak scale as needed)
                const impulseScale = 1.5; // tuning constant
                const impulse =
                    Math.min(18, Math.abs(arm.spinVel)) * impulseScale;

                const b = die.body;
                // set instant velocity addition
                Body.setVelocity(b, {
                    x: b.velocity.x + tangDir.x * impulse,
                    y: b.velocity.y + tangDir.y * impulse,
                });

                // add a small angular kick
                Body.setAngularVelocity(
                    b,
                    b.angularVelocity + (Math.random() - 0.5) * 3 + sign * 1.2,
                );
            }
        });
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
    world.rollEndAt = world.rollStart + 1.5;
    world.settleEndAt = world.rollEndAt + 2.1;
    world.allowFinalize = false;

    dice.forEach((die) => {
        die.targetValue = 1 + Math.floor(Math.random() * 6);
        die.displayValue = 1 + Math.floor(Math.random() * 6);
        die.nextFaceChangeAt = world.time + Math.random() * 0.06;

        // small random nudge so dice are not perfectly aligned
        const b = die.body;
        Body.setAngularVelocity(b, (Math.random() - 0.5) * 4);
    });
    // spin the arm instead of random global impulses
    // choose a starting spin velocity (radians/sec) and let it decay
    const minSpin = 9;
    const maxSpin = 16;
    world.arm.spinVel = minSpin + Math.random() * (maxSpin - minSpin);
    resultText.textContent = "rolling...";
});

// removed automatic random scatter on load to avoid immediate ejection
requestAnimationFrame(frame);
