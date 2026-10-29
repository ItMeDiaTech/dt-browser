// Shared catalogue for the benchmark store. Prices appear only on product pages.
const PRODUCTS = [
  { id: "m185", name: "Logitech M185 Wireless Mouse", price: "$14.99", tags: "wireless mouse logitech" },
  { id: "m330", name: "Logitech M330 Silent Wireless Mouse", price: "$24.99", tags: "wireless mouse logitech silent" },
  { id: "mx3", name: "Logitech MX Master 3S Wireless Mouse", price: "$99.99", tags: "wireless mouse logitech mx" },
  { id: "rz1", name: "Razer DeathAdder Wired Gaming Mouse", price: "$39.99", tags: "wired mouse gaming razer" },
  { id: "kb1", name: "Keychron K2 Wireless Keyboard", price: "$79.00", tags: "wireless keyboard keychron" },
  { id: "pad", name: "SteelSeries QcK Mouse Pad", price: "$9.99", tags: "mouse pad steelseries" },
  { id: "hub", name: "Anker 7-in-1 USB-C Hub", price: "$34.99", tags: "usb hub anker" },
];
const NAV = `<header><a href="index.html">Home</a> · <a href="results.html?q=deals">Deals</a> · <a href="results.html?q=keyboard">Keyboards</a> · <a href="results.html?q=mouse">Mice</a> · <a href="newsletter.html">Newsletter</a> · <a href="#help">Help</a> · <a href="#account">Account</a> · <a href="#cart">Cart (0)</a></header>`;
const FOOTER = `<footer><p>© 2026 BenchMart. Free shipping over $50. 30-day returns.</p><a href="#about">About</a> <a href="#careers">Careers</a> <a href="#privacy">Privacy</a> <a href="#terms">Terms</a> <a href="#contact">Contact</a></footer>`;

function addToCart(id) {
  const p = PRODUCTS.find(x => x.id === id);
  const n = Number(sessionStorage.getItem("cart") || 0) + 1; sessionStorage.setItem("cart", n);
  document.querySelector('a[href="#cart"]').textContent = `Cart (${n})`;
  let m = document.getElementById("cartmsg"); if (!m) { m = document.createElement("p"); m.id = "cartmsg"; document.body.prepend(m); }
  m.textContent = `Added ${p.name} to your cart. Cart now has ${n} item(s).`;
}
