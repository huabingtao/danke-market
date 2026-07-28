#!/usr/bin/env python3
# -*- coding: utf-8 -*-

"""
欢乐牧场本地截图识别与同步脚本 (无需浏览器版)
功能：读取本地截图，垂直分割为左中右三列进行 OCR 识别，并自动同步到云端看板。
"""

import os
import sys
import re
import requests
import traceback
from datetime import datetime

# ==================== 配置区 ====================
# 看板服务端 API 地址
SERVER_URL = "http://happyranch.guaguahub.cn"
# 超管授权密码
ADMIN_PASSWORD = "admin_change_me"
# ===============================================

# 固定的 OwnerId，表示此由手动截图脚本同步的数据
BOT_OWNER_ID = "douyin_sync_bot_manual"

# 尝试加载 macOS 原生 Vision OCR
HAS_MAC_OCR = False
if sys.platform == 'darwin':
    try:
        import Vision
        import Cocoa
        HAS_MAC_OCR = True
        print("[OCR] 检测到 macOS 系统，启用原生 Vision 高速文字识别模块")
    except ImportError:
        pass

# 延迟加载 easyocr 备用
_easyocr_reader = None

def get_easyocr_reader():
    global _easyocr_reader
    if _easyocr_reader is None:
        try:
            import easyocr
            print("[OCR] 正在加载 EasyOCR 模型（首次运行可能较慢）...")
            _easyocr_reader = easyocr.Reader(['ch_sim', 'en'], gpu=False)
            print("[OCR] EasyOCR 模型加载完毕！")
        except ImportError:
            print("[错误] 未安装 EasyOCR！请运行: pip install easyocr")
            sys.exit(1)
    return _easyocr_reader

def perform_ocr_mac(image_path):
    """利用 Mac 原生 Vision 框架进行离线 OCR 识别"""
    image_url = Cocoa.NSURL.fileURLWithPath_(os.path.abspath(image_path))
    handler = Vision.VNImageRequestHandler.alloc().initWithURL_options_(image_url, None)
    
    results = []
    def request_handler(request, error):
        if error:
            print(f"[OCR 错误] Vision 识别出错: {error}")
            return
        observations = request.results()
        for observation in observations:
            candidates = observation.topCandidates_(1)
            if candidates:
                results.append(candidates[0].string())

    request = Vision.VNRecognizeTextRequest.alloc().initWithCompletionHandler_(request_handler)
    request.setRecognitionLevel_(Vision.VNRequestTextRecognitionLevelAccurate)
    request.setRecognitionLanguages_(["zh-Hans", "en-US"])
    
    success, error = handler.performRequests_error_([request], None)
    if not success:
        print(f"[OCR 错误] 无法执行识别请求: {error}")
        return []
    return results

def perform_ocr_easy(image_path):
    """跨平台 EasyOCR 备用识别"""
    reader = get_easyocr_reader()
    ocr_result = reader.readtext(image_path)
    return [item[1] for item in ocr_result]

def perform_ocr(image_path):
    """统一文字识别接口"""
    if HAS_MAC_OCR:
        try:
            return perform_ocr_mac(image_path)
        except Exception as e:
            print(f"[OCR 降级] Mac 原生 OCR 识别失败，尝试切换到 EasyOCR: {e}")
            return perform_ocr_easy(image_path)
    else:
        return perform_ocr_easy(image_path)

def split_image_into_columns(image_path):
    """
    将图片垂直切分为左、中、右三等分，返回切分后的临时图片路径列表
    """
    col_paths = []
    try:
        from PIL import Image
        img = Image.open(image_path)
        w, h = img.size
        
        # 按照三等分进行分割
        col_width = w / 3.0
        
        for i in range(3):
            left = int(i * col_width)
            right = int((i + 1) * col_width)
            if i == 2:
                right = w
                
            col_img = img.crop((left, 0, right, h))
            col_path = image_path.replace(".png", f"_col_{i}.png")
            col_img.save(col_path)
            col_paths.append(col_path)
    except Exception as e:
        print(f"[图片切分失败] 无法使用 PIL 切分列: {e}")
        col_paths = [image_path]
    return col_paths

def parse_column_ocr_text(lines):
    """
    解析单列的 OCR 结果。从上到下按顺序检测标题，
    遇到分类标题后，后续解析到的 ID 和价格都归入该分类，直到遇到下一个分类标题。
    """
    crop_keywords = {
        'egg': ['鸡蛋', '蛋', '鸡'],
        'milk': ['牛奶', '奶', '牛乳'],
        'goose': ['鹅毛', '鹅绒', '鹅', '大鹅', '鹅蛋'],
        'honey': ['蜂蜜', '蜜', '蜂'],
        'wool': ['羊毛', '绵羊', '毛'],
        'feather': ['孔雀', '翎羽', '羽']
    }
    
    parsed_results = {k: [] for k in crop_keywords.keys()}
    current_crop = None
    
    for line in lines:
        line_clean = line.strip()
        if not line_clean:
            continue
            
        # 1. 尝试匹配分类标题
        matched_crop = None
        if '羊毛' in line_clean:
            matched_crop = 'wool'
        elif '鹅毛' in line_clean or '鹅绒' in line_clean or '大鹅' in line_clean:
            matched_crop = 'goose'
        elif '孔雀' in line_clean or '翎羽' in line_clean:
            matched_crop = 'feather'
        elif '鸡蛋' in line_clean:
            matched_crop = 'egg'
        elif '牛奶' in line_clean:
            matched_crop = 'milk'
        elif '蜂蜜' in line_clean:
            matched_crop = 'honey'
        else:
            # 模糊匹配单字
            for crop, keywords in crop_keywords.items():
                if any(kw in line_clean for kw in keywords):
                    matched_crop = crop
                    break
                    
        if matched_crop:
            current_crop = matched_crop
            continue
            
        # 2. 如果已选定分类，尝试提取数据行
        if current_crop:
            numbers = re.findall(r'\d+', line_clean)
            if not numbers:
                continue
                
            player_id = None
            price = None
            
            for num in numbers:
                val = int(num)
                # ID为8-10位纯数字，价格为100-7500
                if 8 <= len(num) <= 10:
                    player_id = num
                elif 100 <= val <= 7500:
                    price = val
                    
            if player_id and price:
                if not any(item['id'] == player_id for item in parsed_results[current_crop]):
                    parsed_results[current_crop].append({
                        'id': player_id,
                        'price': price
                    })
                    
    return parsed_results

def sync_data_to_server(local_data, live_tag):
    """
    同步算法：清空旧的同步内容并全量同步最新截图的数据
    """
    print(f"\n正在向云端看板 [{SERVER_URL}] 提交同步请求...")
    try:
        # 获取当前看板数据
        response = requests.get(f"{SERVER_URL}/api/load")
        if response.status_code != 200:
            print(f"[同步失败] 无法加载云端数据，HTTP 状态码: {response.status_code}")
            return
        remote_board = response.json()
        
        # 1. 先清除当前 tag (或 BOT_OWNER_ID) 下的历史数据
        for crop_key, items in remote_board.items():
            for item in items:
                if item.get('ownerId') == BOT_OWNER_ID:
                    requests.post(f"{SERVER_URL}/api/delete", json={
                        "cropKey": crop_key,
                        "itemId": item['itemId'],
                        "ownerId": BOT_OWNER_ID,
                        "adminToken": ADMIN_PASSWORD
                    })
                    
        # 2. 写入新解析到的全部高价
        for crop_key, local_items in local_data.items():
            for local_item in local_items:
                player_id = local_item['id']
                price = local_item['price']
                
                add_res = requests.post(f"{SERVER_URL}/api/add", json={
                    "cropKey": crop_key,
                    "id": player_id,
                    "price": price,
                    "ownerId": BOT_OWNER_ID,
                    "adminToken": ADMIN_PASSWORD
                })
                if add_res.status_code == 200:
                    print(f"➕ 新增 {crop_key.upper()} - ID: {player_id} 价格: {price}")
                else:
                    print(f"❌ 新增失败 {crop_key.upper()} - ID: {player_id}: {add_res.text}")
                    
    except Exception as e:
        print(f"[同步异常] 数据写入云端失败: {e}")
        traceback.print_exc()

def main():
    print("=== 欢乐牧场本地截图识别与同步脚本 ===")
    
    # 检查命令行参数
    if len(sys.argv) > 1:
        image_path = sys.argv[1].strip()
    else:
        image_path = input("请输入（或直接将图片拖入终端）截图文件的路径：").strip()
        
    image_path = image_path.strip("'\"")
    
    if not image_path:
        print("[错误] 未指定截图文件路径！")
        return
        
    if not os.path.exists(image_path):
        print(f"[错误] 找不到指定的截图文件: {image_path}")
        return
        
    print(f"\n🚀 开始处理截图: {image_path}")
    
    # 1. 垂直切分为左、中、右三等分
    col_paths = split_image_into_columns(image_path)
    
    # 2. 依次识别和解析每一列
    parsed_data = {
        'egg': [], 'milk': [], 'goose': [], 'honey': [], 'wool': [], 'feather': []
    }
    
    for i, col_path in enumerate(col_paths):
        lines = perform_ocr(col_path)
        col_data = parse_column_ocr_text(lines)
        for crop, items in col_data.items():
            parsed_data[crop].extend(items)
        if os.path.exists(col_path) and col_path != image_path:
            os.remove(col_path)
            
    # 打印最终提取结果
    print("\n--- 提取到的挂菜数据如下 ---")
    total_detected = 0
    for crop, items in parsed_data.items():
        if items:
            total_detected += len(items)
            print(f"  [{crop.upper()}]:")
            for item in items:
                print(f"    └─ ID: {item['id']}，价格: {item['price']}")
                
    if total_detected == 0:
        print("  ⚠️ 没有识别到任何挂菜数据，请检查截图是否清晰。")
        return
        
    # 3. 同步至云端看板
    confirm = input("\n请确认以上数据无误，输入 'y' 确认同步，或按其他任意键取消: ").strip().lower()
    if confirm == 'y':
        sync_data_to_server(parsed_data, "manual_import")
        print("\n🎉 同步成功！数据已更新至看板。")
    else:
        print("\n❌ 操作已取消，数据未同步。")

if __name__ == '__main__':
    main()
