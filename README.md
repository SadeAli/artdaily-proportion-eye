# Proportion Eye — Art Daily drill

Split lengths by eye, and answer with your hand: every item is solved by
drawing a short tick across the thing being measured. Six items per round,
in this order: the midpoint of a bare segment, both thirds, both thirds of
a steep segment, a stated ratio like 5/8 from the left end, half a standing
figure's height (the classic 7.5-heads figure, with an unlabelled head-unit
ruler beside it while you guess), and a midpoint again — the round ends on
the item beginners are best at, not on arithmetic. A tick landing near the
line is snapped onto it rather than refused, undo stays live for 1.8s after
the last tick, and each reveal waits for a tap. After each item the true
divisions appear with your miss in both % and px, and the HUD carries a
running mean.

Scoring is pure fraction geometry (`js/game.js`, top of file): each mark's
error is its distance from the true division — within 1% of the length is
perfect, 11% off is zero, and both windows have an absolute pixel floor run
through `ArtDaily.ease()`, so a 215px phone segment is not judged against a
2.15px perfect zone while a desktop gets 4.5px; item = mean of its marks,
round = mean of six items. Part of [artdaily.sadeali.com](https://artdaily.sadeali.com/):
zero build, no trackers, vendored SDK in `js/artdaily-sdk.js`.
