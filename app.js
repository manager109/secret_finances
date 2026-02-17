const STORAGE_KEY = "finance-operations-v1";

const categories = {
  income: ["Зарплата", "Подработка", "Подарок", "Другое"],
  expense: ["Еда", "Развлечения", "Транспорт", "Покупки", "Здоровье", "Другое"]
};

const operationForm = document.querySelector("#operationForm");
const typeField = document.querySelector("#type");
const categoryField = document.querySelector("#category");
const amountField = document.querySelector("#amount");
const dateField = document.querySelector("#date");
const noteField = document.querySelector("#note");
const monthFilterField = document.querySelector("#monthFilter");
const operationsList = document.querySelector("#operationsList");
const operationTemplate = document.querySelector("#operationTemplate");
const clearDataBtn = document.querySelector("#clearDataBtn");

const incomeTotal = document.querySelector("#incomeTotal");
const expenseTotal = document.querySelector("#expenseTotal");
const balanceTotal = document.querySelector("#balanceTotal");

const formatAmount = (value) => `${new Intl.NumberFormat("ru-RU").format(value)} ₽`;

const getOperations = () => {
  const data = localStorage.getItem(STORAGE_KEY);
  return data ? JSON.parse(data) : [];
};

const saveOperations = (operations) => {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(operations));
};

const updateCategories = () => {
  const selectedType = typeField.value;
  categoryField.innerHTML = "";

  categories[selectedType].forEach((category) => {
    const option = document.createElement("option");
    option.value = category;
    option.textContent = category;
    categoryField.append(option);
  });
};

const getFilteredOperations = (operations) => {
  if (!monthFilterField.value) {
    return operations;
  }

  return operations.filter((operation) => operation.date.startsWith(monthFilterField.value));
};

const renderTotals = (operations) => {
  const income = operations
    .filter((operation) => operation.type === "income")
    .reduce((sum, operation) => sum + operation.amount, 0);

  const expense = operations
    .filter((operation) => operation.type === "expense")
    .reduce((sum, operation) => sum + operation.amount, 0);

  incomeTotal.textContent = formatAmount(income);
  expenseTotal.textContent = formatAmount(expense);
  balanceTotal.textContent = formatAmount(income - expense);
};

const renderOperations = () => {
  const operations = getOperations();
  const filteredOperations = getFilteredOperations(operations)
    .sort((a, b) => b.date.localeCompare(a.date));

  operationsList.innerHTML = "";

  if (!filteredOperations.length) {
    operationsList.innerHTML = '<li class="empty-state">Пока нет операций за выбранный период</li>';
    renderTotals([]);
    return;
  }

  filteredOperations.forEach((operation) => {
    const element = operationTemplate.content.firstElementChild.cloneNode(true);
    const amountClass = operation.type === "income" ? "operations__amount--income" : "operations__amount--expense";
    const amountPrefix = operation.type === "income" ? "+" : "-";

    element.querySelector(".operations__title").textContent = `${operation.category}${operation.note ? ` · ${operation.note}` : ""}`;
    element.querySelector(".operations__meta").textContent = new Date(operation.date).toLocaleDateString("ru-RU");

    const amountNode = element.querySelector(".operations__amount");
    amountNode.textContent = `${amountPrefix}${formatAmount(operation.amount)}`;
    amountNode.classList.add(amountClass);

    element.querySelector(".operations__delete").addEventListener("click", () => {
      const nextOperations = getOperations().filter((item) => item.id !== operation.id);
      saveOperations(nextOperations);
      renderOperations();
    });

    operationsList.append(element);
  });

  renderTotals(filteredOperations);
};

operationForm.addEventListener("submit", (event) => {
  event.preventDefault();

  const amount = Number(amountField.value);
  if (!Number.isFinite(amount) || amount <= 0) {
    return;
  }

  const nextOperation = {
    id: crypto.randomUUID(),
    type: typeField.value,
    category: categoryField.value,
    amount,
    date: dateField.value,
    note: noteField.value.trim()
  };

  const operations = getOperations();
  operations.push(nextOperation);
  saveOperations(operations);

  operationForm.reset();
  typeField.value = nextOperation.type;
  updateCategories();
  dateField.valueAsDate = new Date();
  renderOperations();
});

clearDataBtn.addEventListener("click", () => {
  localStorage.removeItem(STORAGE_KEY);
  renderOperations();
});

typeField.addEventListener("change", updateCategories);
monthFilterField.addEventListener("change", renderOperations);

updateCategories();
dateField.valueAsDate = new Date();
monthFilterField.value = new Date().toISOString().slice(0, 7);
renderOperations();
