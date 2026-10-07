import { seedBulkCount } from './env';

//the one env reader with input of its own: SEED_BULK goes through it so a typo refuses instead of seeding a smaller set

describe('seedBulkCount', () => {
    const previous = process.env.SEED_BULK;

    afterEach(() => {
        if (previous === undefined) delete process.env.SEED_BULK;
        else process.env.SEED_BULK = previous;
    });

    it('unset or blank is the 2000 default, a whole number is taken as is, 0 included', () => {
        delete process.env.SEED_BULK;
        expect(seedBulkCount()).toBe(2000);
        for (const blank of ['', '  ']) {
            process.env.SEED_BULK = blank;
            expect(seedBulkCount()).toBe(2000);
        }
        process.env.SEED_BULK = '500';
        expect(seedBulkCount()).toBe(500);
        process.env.SEED_BULK = ' 0 ';
        expect(seedBulkCount()).toBe(0);
    });

    it('refuses anything that is not a whole number', () => {
        for (const bad of ['-5', '2.5', '1e3', 'abc', '2,000', '0x10']) {
            process.env.SEED_BULK = bad;
            expect(() => seedBulkCount()).toThrow('SEED_BULK');
        }
    });
});
