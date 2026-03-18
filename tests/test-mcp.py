import requests
import json

#BASE_URL = "https://mcp.feishu.cn/mcp/mcp_gZdLF0PM9mZwMEeLNovbJO2OxknlEqpF92Kq5Mu85n-iqkl37pk4tDh01Dijki75-_iycGVP1n4"
BASE_URL= "http://localhost:18788/mcp/mcp-feishu"
def list_tools():
    url = BASE_URL

    headers = {
        "Content-Type": "application/json",
    }

    payload = {
        "jsonrpc": "2.0",
        "id": 1,
        "method": "tools/list",
        "params": {}
    }

    response = requests.post(url, headers=headers, json=payload, timeout=30)

    print("Status:", response.status_code)
    print("Response raw:", response.text)

    try:
        data = response.json()
        print("\nParsed response:")
        print(json.dumps(data, indent=2, ensure_ascii=False))
    except Exception as e:
        print("JSON parse error:", e)

if __name__ == "__main__":
    list_tools()