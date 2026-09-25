// Builds a realistic sample lead sheet for the user guide screenshots.
const path = require("path");
const ExcelJS = require(path.join(__dirname, "../../node_modules/exceljs"));

const rows = [
  ["First Name", "Last Name", "Email", "Company", "Job Title", "Website", "Industry", "Location", "LinkedIn", "Notes"],
  ["Priya", "Nair", "priya.nair@example-fintech.in", "Kestrel Payments", "Head of Engineering", "https://kestrelpayments.example", "Fintech", "Bengaluru, India", "https://linkedin.com/in/priya-nair-example", "Scaling a UPI settlement platform; hiring backend engineers"],
  ["Rahul", "Mehta", "rahul.mehta@example-health.in", "Meridian Health Labs", "Chief Technology Officer", "https://meridianhealth.example", "Healthcare", "Mumbai, India", "https://linkedin.com/in/rahul-mehta-example", "Digitising diagnostic lab reports for 200 collection centres"],
  ["Ananya", "Iyer", "ananya.iyer@example-retail.in", "Saffron Basket", "Founder", "https://saffronbasket.example", "E-commerce", "Chennai, India", "https://linkedin.com/in/ananya-iyer-example", "D2C grocery brand; inventory sync issues across Shopify and warehouses"],
  ["Vikram", "Singh", "vikram.singh@example-logistics.in", "NorthStar Freight", "VP Operations", "https://northstarfreight.example", "Logistics", "Delhi, India", "https://linkedin.com/in/vikram-singh-example", "Fleet of 450 trucks; still tracking dispatch in spreadsheets"],
  ["Meera", "Krishnan", "meera.k@example-edtech.in", "Lumen Academy", "Product Lead", "https://lumenacademy.example", "Education", "Hyderabad, India", "https://linkedin.com/in/meera-krishnan-example", "Launching a mobile app for K-12 tutoring; needs a data pipeline"],
  ["Arjun", "Desai", "arjun.desai@example-realty.in", "Blue Harbour Realty", "Managing Director", "https://blueharbour.example", "Real estate", "Pune, India", "https://linkedin.com/in/arjun-desai-example", "Wants a CRM that talks to the site-visit booking form"],
  ["Sneha", "Patel", "bounce@example-manufacturing.in", "Ironleaf Manufacturing", "Plant Manager", "https://ironleaf.example", "Manufacturing", "Ahmedabad, India", "", "Old email address; will bounce"],
  ["Karan", "Bose", "karan.bose@example-media.in", "Studio Umbra", "Creative Director", "https://studioumbra.example", "Media", "Kolkata, India", "https://linkedin.com/in/karan-bose-example", "Agency of 40; exploring AI-assisted video subtitling"],
];

(async () => {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Leads");
  rows.forEach((r) => ws.addRow(r));
  ws.getRow(1).font = { bold: true };
  ws.columns.forEach((c) => (c.width = 28));
  const out = path.join(__dirname, "sample-leads.xlsx");
  await wb.xlsx.writeFile(out);
  console.log("wrote", out, rows.length - 1, "leads");
})();
