// The demonstration notice every page on the site carries. Server-rendered pages get it
// from src/demo-banner.ts; this is the same text for the /pay build, which is a
// separate bundle and cannot import from src/. test/demo-banner.test.ts fails if the
// two ever say different things. Not dismissible, on purpose.
//
// Styles are in styles.css (.iom-demo), in the same gold as the server pages, and follow
// the `.dark` class the console's theme toggle sets.

export const DEMO_BANNER_LEAD = "Demonstration only.";
export const DEMO_BANNER_BODY =
  "This is a technology demonstration that has been tested on real data with real money in a limited pilot. It is not offered as a commercial service until the required licences, penetration testing and security audits are complete.";

export function DemoBanner() {
  return (
    <div className="iom-demo" role="note" aria-label="Demonstration notice">
      <div className="iom-demo-in">
        <b>{DEMO_BANNER_LEAD}</b> {DEMO_BANNER_BODY}
      </div>
    </div>
  );
}
