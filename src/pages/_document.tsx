import BootScreen from '@app/components/BootScreen';
import type { DocumentContext, DocumentInitialProps } from 'next/document';
import Document, { Head, Html, Main, NextScript } from 'next/document';

import type { JSX } from 'react';

class MyDocument extends Document {
  static async getInitialProps(
    ctx: DocumentContext
  ): Promise<DocumentInitialProps> {
    const initialProps = await Document.getInitialProps(ctx);

    return initialProps;
  }

  render(): JSX.Element {
    return (
      // Seerr AI is always dark; "dark" turns on the `dark:` styles
      // (tailwind.config.js) whatever the device's own setting.
      <Html className="dark">
        <Head />
        <body>
          <BootScreen />
          <Main />
          <NextScript />
        </body>
      </Html>
    );
  }
}

export default MyDocument;
