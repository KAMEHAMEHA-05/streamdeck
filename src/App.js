import { useState } from "react";
import Login from "./Login";
import Home from "./Home"; // your streaming UI
import Setup from "./Setup";

export default function App() {
  const [loggedIn, setLoggedIn] = useState(
    !!localStorage.getItem("accessToken")
  );

  if (!loggedIn) return <Login onLogin={() => setLoggedIn(true)} />;

  const path = window.location.pathname;

  if (path === "/setup") {
    return <Setup />;
  }

  return <Home />;
}
