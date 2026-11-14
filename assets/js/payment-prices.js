window.PaymentPrices = (() => {
  const creditMethod = "Tarjeta de crédito";
  const cardMoney = new Intl.NumberFormat("es-AR", {
    style: "currency",
    currency: "ARS",
    minimumFractionDigits: 2
  });

  const financingRates = [0, 0, 0.0779, 0.1049];

  function cardPrice(basePrice, installments = 1) {
    return Math.round(Number(basePrice) / (1 - (0.046 + financingRates[installments]) * 1.21) * 100) / 100;
  }

  function planLabel(basePrice, installments) {
    const total = cardPrice(basePrice, installments);
    if (installments === 1) return `1 pago de ${cardMoney.format(total)}`;
    return `${installments} cuotas de aprox. ${cardMoney.format(total / installments)} · Total ${cardMoney.format(total)}`;
  }

  function priceMarkup(basePrice, formatBase) {
    return `<span class="payment-prices">
      <span>${formatBase(basePrice)} <small>Ef./Transf.</small></span>
      <span class="payment-price-card">Tarjeta · Hasta 3 cuotas</span>
    </span>`;
  }

  return { cardPrice, cardMoney, creditMethod, priceMarkup, planLabel };
})();
