window.PaymentPrices = (() => {
  const creditMethod = "Tarjeta de crédito";
  const cardMoney = new Intl.NumberFormat("es-AR", {
    style: "currency",
    currency: "ARS",
    minimumFractionDigits: 2
  });

  function cardPrice(basePrice) {
    return Math.round(Number(basePrice) / (1 - 0.046 * 1.21) * 100) / 100;
  }

  function priceMarkup(basePrice, formatBase, selectedPayment = "") {
    return `<span class="payment-prices">
      <span>${formatBase(basePrice)} <small>Ef./Transf.</small></span>
      <span class="payment-price-card">${cardMoney.format(cardPrice(basePrice))} <small>Tarjeta</small>${selectedPayment === creditMethod ? ' <span class="payment-price-selected">· Seleccionada</span>' : ""}</span>
    </span>`;
  }

  return { cardPrice, cardMoney, creditMethod, priceMarkup };
})();
