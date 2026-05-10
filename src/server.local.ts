import "dotenv/config";
import { app } from "./app.js";

const PORT = Number(process.env.PORT || 3000);
app.listen(PORT, "0.0.0.0", () => {
  console.log(`🟢 http://localhost:${PORT}/graphql`);
  console.log(`🟢 http://localhost:${PORT}/api/graphql`);
  console.log(`🟢 http://localhost:${PORT}/api/speech`);
});

