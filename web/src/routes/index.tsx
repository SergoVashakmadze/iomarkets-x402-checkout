import { createFileRoute } from "@tanstack/react-router";
import { ProgressRail, TopBar } from "@/components/io/Chrome";
import { StepRecipients } from "@/components/io/StepRecipients";
import { StepReview } from "@/components/io/StepReview";
import { StepPay } from "@/components/io/StepPay";
import { StepReceipts } from "@/components/io/StepReceipts";
import { BatchProvider, useBatch } from "@/lib/io/store";

const TITLE = "IoMarkets — Batch payouts globally, settled in USDC";
const DESCRIPTION =
  "Paste a spreadsheet, lock a price for every recipient, approve once, and watch each cross-border payout settle with an on-chain receipt.";

export const Route = createFileRoute("/")({
  validateSearch: (search: Record<string, unknown>): { demo?: boolean } =>
    search["demo"] === "1" || search["demo"] === true ? { demo: true } : {},
  head: () => ({
    meta: [
      { title: TITLE },
      { name: "description", content: DESCRIPTION },
      { property: "og:title", content: TITLE },
      { property: "og:description", content: DESCRIPTION },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Index,
});

function Steps() {
  const { step } = useBatch();
  return (
    <main>
      {step === 1 && <StepRecipients />}
      {step === 2 && <StepReview />}
      {step === 3 && <StepPay />}
      {step === 4 && <StepReceipts />}
    </main>
  );
}

function Index() {
  const { demo } = Route.useSearch();
  return (
    <BatchProvider demo={Boolean(demo)}>
      <div className="min-h-screen bg-background text-foreground">
        <TopBar />
        <ProgressRail />
        <h1 className="sr-only">IoMarkets batch payout console</h1>
        <Steps />
      </div>
    </BatchProvider>
  );
}
