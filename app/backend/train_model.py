
import pandas as pd
import numpy as np
from sklearn.ensemble import RandomForestRegressor
from sklearn.model_selection import train_test_split
import joblib
import os

CSV_PATH = "/mnt/data/nutriscan_1200_semi_realistic.csv"
MODEL_OUT = "model.pkl"

def featurize_text(s):
    s = str(s).lower()
    return [len(s), sum(c.isdigit() for c in s), int("e" in s), int("sugar" in s), int("hydro" in s or "trans" in s)]

def main():
    if not os.path.exists(CSV_PATH):
        raise FileNotFoundError(f"CSV not found at {CSV_PATH}")
    df = pd.read_csv(CSV_PATH)
    if "score" not in df.columns:
        df["score"] = df["ingredient"].apply(lambda s: 50 + 20*("sugar" in str(s).lower()) + 15*(any(ch.isdigit() for ch in str(s))) )
    X = np.vstack(df["ingredient"].apply(featurize_text).values)
    y = df["score"].values
    X_train, X_test, y_train, y_test = train_test_split(X,y,test_size=0.2,random_state=42)
    model = RandomForestRegressor(n_estimators=100, random_state=42)
    model.fit(X_train, y_train)
    print("train score:", model.score(X_train,y_train))
    print("test score:", model.score(X_test,y_test))
    joblib.dump(model, MODEL_OUT)
    print("Saved model to", MODEL_OUT)

if __name__ == "__main__":
    main()
