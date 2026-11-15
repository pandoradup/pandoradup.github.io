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
    const totalCents = Math.round(total * 100);
    const installmentCents = Math.floor(totalCents / installments);
    const extraCentCount = totalCents % installments;
    const regularAmount = cardMoney.format(installmentCents / 100);
    const totalLabel = ` · Total ${cardMoney.format(total)}`;
    if (extraCentCount === 0) {
      return `${installments} cuotas de ${regularAmount}${totalLabel}`;
    }

    const higherAmount = cardMoney.format((installmentCents + 1) / 100);
    const regularCount = installments - extraCentCount;
    return `${installments} cuotas · ${extraCentCount} × ${higherAmount} + ${regularCount} × ${regularAmount}${totalLabel}`;
  }

  function priceMarkup(basePrice, formatBase) {
    return `<span class="payment-prices">
      <span>${formatBase(basePrice)} <small>Ef./Transf.</small></span>
      <span class="payment-price-card">Hasta 3 cuotas con tarjeta · Precio según el plan</span>
    </span>`;
  }

  return { cardPrice, cardMoney, creditMethod, priceMarkup, planLabel };
})();
