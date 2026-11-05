import express from 'express';
import path from 'node:path';

/**
 * Country flags, one small file each, from the package the client validates
 * codes against. Serving them individually avoids a 200 KB sheet per title
 * page; region lists fetch only flags scrolled into view.
 */
const FLAG_DIRECTORY = path.join(
  path.dirname(require.resolve('country-flag-icons/package.json')),
  '3x2'
);

const flags = express.Router();

// Flag files are named by country code: two capital letters, or a few
// three-part ones like GB-ENG. Anything else isn't a flag.
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
    // Flags only change with the package.
    maxAge: '30d',
  })
);

export default flags;
