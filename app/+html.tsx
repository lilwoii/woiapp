import { ScrollViewStyleReset } from 'expo-router/html';

export default function Root({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta httpEquiv="X-UA-Compatible" content="IE=edge" />
        <meta name="viewport" content="width=device-width, initial-scale=1, shrink-to-fit=no" />
        <title>Spottr · Live local food, mapped</title>
        <meta
          name="description"
          content="Find nearby food trucks, restaurants, pop-ups, bakeries, and verified local kitchens with live locations, menus, payments, reviews, and owner updates."
        />
        <meta name="theme-color" content="#F6F3EC" />
        <meta property="og:title" content="Spottr · Live local food, mapped" />
        <meta
          property="og:description"
          content="Know what is serving, where it is, what it costs, and how you can pay—before you go."
        />
        <meta property="og:type" content="website" />
        <meta property="og:image" content="/og.png" />
        <meta name="twitter:card" content="summary_large_image" />
        <meta name="twitter:image" content="/og.png" />
        <ScrollViewStyleReset />
        <style dangerouslySetInnerHTML={{ __html: responsiveBackground }} />
      </head>
      <body>{children}</body>
    </html>
  );
}

const responsiveBackground = `
body {
  background-color: #F6F3EC;
  color: #191D1B;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}
* {
  box-sizing: border-box;
}
::selection {
  background: #FFE0D7;
  color: #191D1B;
}
button, input, textarea {
  font: inherit;
}
:focus-visible {
  outline: 3px solid rgba(241, 90, 58, 0.38);
  outline-offset: 2px;
}
`;
