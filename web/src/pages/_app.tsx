import "@/styles/globals.css";
import type { AppProps } from "next/app";
import { AccountGate } from "@/components/account-gate";

export default function App({ Component, pageProps }: AppProps) {
  return <AccountGate><Component {...pageProps} /></AccountGate>;
}
