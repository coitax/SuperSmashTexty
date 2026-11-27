import {
    assert,
    assertCreditsStayHonest,
    joinAndSeed,
    sendHost
} from '../support/saveTamperHarness.js';

const startingCurrency = 80;
const mode = process.argv[2];
await joinAndSeed({ currency: startingCurrency });

if (mode === 'negative') {
    sendHost('currency_gain', { value: -1000000000 });
} else if (mode === 'huge') {
    sendHost('currency_gain', { value: 1e20 });
} else {
    throw new Error(`unknown currency_gain mode ${mode}`);
}

assertCreditsStayHonest(startingCurrency);
assert.equal(process.argv[2] === 'negative' || process.argv[2] === 'huge', true);
