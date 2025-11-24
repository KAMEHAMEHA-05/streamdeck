import { useState } from "react";
import Login from "./Login";
import Home from "./Home"; // your streaming UI

export default function App() {
  const [loggedIn, setLoggedIn] = useState(
    !!localStorage.getItem("accessToken")
  );

  if (!loggedIn) return <Login onLogin={() => setLoggedIn(true)} />;

  return <Home />;
}
