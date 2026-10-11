import express from 'express';
import path from 'node:path';

/**
 * Country flags, one small file each, from the same package the interface
 * checks codes against. The whole set as one stylesheet was 200 KB on every
 * title page for the one or two flags it shows; a region list fetches only
 * the flags scrolled into view.
 */
const FLAG_DIRECTORY = path.join(
  path.dirname(require.resolve('country-flag-icons/package.json')),
  '3x2'
);

const flags = express.Router();

// A flag file is named by its country code: two capital letters, or the few
// three-part ones like GB-ENG. Anything else is not a flag.
flags.use((req, res, next) => {
  if (!/^\/[A-Z]{2}(?:-[A-Z]{2,3})?\.svg$/.test(req.path)) {
    return res.status(404).end();
  }
  next();
});

flags.use(
  express.static(FLAG_DIRECTORY, {
    fallthrough: false,
    index: false,
    // Flags change only with the package; a month is plenty.
    maxAge: '30d',
  })
);

export default flags;
