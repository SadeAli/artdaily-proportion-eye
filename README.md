# Proportion Eye — Art Daily drill

Split lengths by eye, and answer with your hand: every item is solved by
drawing a short tick across the thing being measured. Six items per round —
the midpoint of a bare segment (x2), both thirds (x2), half a standing
figure's height (the classic 7.5-heads mannequin), then a stated ratio
like 5/8 from the left end. Ticks are undoable until the item auto-scores;
after each item the true divisions appear in mint with your % off.

Scoring is pure fraction geometry (`js/game.js`, top of file): each mark's
error is its distance from the true division as a fraction of the full
length — within 1% is perfect, 11% off is zero; item = mean of its marks,
round = mean of six items. Part of [artdaily.sadeali.com](https://artdaily.sadeali.com/):
zero build, no trackers, vendored SDK in `js/artdaily-sdk.js`.
