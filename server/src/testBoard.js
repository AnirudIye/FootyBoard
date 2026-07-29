import { SCHEMA_VERSION } from '../../src/lib/boardSchema.js'

/**
 * A board payload for the suite to save.
 *
 * The tests here are about sharing, presence, revocation and caches rather than
 * about board contents, so they used to post `{ version: 1 }` and think no more
 * about it. That was free right up until the write path started checking that a
 * board is a board, and it was never harmless: `node --test` runs against the
 * dev database, so every one of those calls left behind a row the real client
 * cannot open. Several of the unloadable rows in that database are from here.
 *
 * Shaped like something the app would actually write rather than pared down to
 * whatever the guard happens to demand, so a test posting this is exercising the
 * same path a coach saving a board is. `version` comes from the shared schema
 * module rather than being typed out, so a schema bump does not leave the suite
 * quietly writing last version's boards.
 */
export const testBoard = (overrides = {}) => ({
  version: SCHEMA_VERSION,
  teams: [
    { id: 'home', side: 'home', name: 'Home', color: '#B4432E' },
    { id: 'away', side: 'away', name: 'Away', color: '#2C5B8A' },
  ],
  tokens: [
    {
      id: 'tok-keeper',
      type: 'player',
      teamId: 'home',
      number: 1,
      color: '#B4432E',
      shape: 'keeper',
      x: 6,
      y: 50,
      rotation: 0,
    },
    {
      id: 'tok-striker',
      type: 'player',
      teamId: 'away',
      number: 9,
      color: '#2C5B8A',
      shape: 'round',
      x: 72,
      y: 50,
      rotation: 0,
    },
  ],
  bench: [],
  drawings: [],
  frames: [],
  view: {
    view: 'fullH',
    kind: '11',
    grass: true,
    lineColor: '#F2F6F1',
    overlayGrid: false,
    pitchTheme: 'dark',
    snap: false,
  },
  customFormations: [],
  ...overrides,
})
