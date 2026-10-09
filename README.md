# Don't Spill the Milk! 🐄🥛

Two-player turn-based game. Take turns squeezing the cow's udder (click it, or press Space).
Each squeeze delivers a random amount of milk. Fill the bottle — whoever makes it overflow loses.

## Run

```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # production build in dist/
```

## How the milk works

- **Stream**: Lagrangian particles under gravity; width follows flow continuity (faster = thinner), and the stream breaks into drips as the flow tapers off.
- **Surface**: a 1D damped wave-equation height field (slightly viscous), with impact dimples, splashes, foam and a meniscus.
- **Overflow**: surface tension lets the milk dome slightly above the rim; beyond that it runs down the glass and pools on the table.

Tweak physics constants at the top of `src/engine.js` (`G`, `LMAX`, damping in `stepWaves`, squeeze size in `press`).
